#!/usr/bin/env node

const env = process.env;

const usage = `Usage:
  atlassian-api.mjs jira:myself
  atlassian-api.mjs jira:get ISSUE-123
  atlassian-api.mjs jira:search 'project = FNR ORDER BY updated DESC' [maxResults]
  atlassian-api.mjs jira:comment ISSUE-123 'Comment body'
  atlassian-api.mjs jira:transitions ISSUE-123
  atlassian-api.mjs jira:transition ISSUE-123 TRANSITION_ID
  atlassian-api.mjs confluence:search 'space = DEV AND text ~ "deployment"'
  atlassian-api.mjs confluence:get PAGE_ID
`;

const command = process.argv[2];
const args = process.argv.slice(3);
const atlassianLocale = env.ATLASSIAN_LOCALE || 'en-US';

const requireEnv = (name) => {
  if (!env[name]) throw new Error(`Missing ${name}`);
  return env[name];
};

const authConfig = () => {
  if (env.ATLASSIAN_BEARER_TOKEN && env.ATLASSIAN_CLOUD_ID) {
    return {
      jiraBase: `https://api.atlassian.com/ex/jira/${env.ATLASSIAN_CLOUD_ID}/rest/api/3`,
      confluenceBase: `https://api.atlassian.com/ex/confluence/${env.ATLASSIAN_CLOUD_ID}/wiki/rest/api`,
      headers: {
        Authorization: `Bearer ${env.ATLASSIAN_BEARER_TOKEN}`,
        Accept: 'application/json',
        'Accept-Language': atlassianLocale,
      },
      mode: 'bearer',
    };
  }

  if (env.ATLASSIAN_EMAIL && env.ATLASSIAN_API_TOKEN && (env.ATLASSIAN_DOMAIN || env.ATLASSIAN_SITE_URL)) {
    const domain = (env.ATLASSIAN_DOMAIN || env.ATLASSIAN_SITE_URL).replace(/^https?:\/\//, '').replace(/\/$/, '');
    const token = Buffer.from(`${env.ATLASSIAN_EMAIL}:${env.ATLASSIAN_API_TOKEN}`).toString('base64');
    return {
      jiraBase: `https://${domain}/rest/api/3`,
      confluenceBase: `https://${domain}/wiki/rest/api`,
      headers: {
        Authorization: `Basic ${token}`,
        Accept: 'application/json',
        'Accept-Language': atlassianLocale,
      },
      mode: 'basic',
    };
  }

  throw new Error('Configure ATLASSIAN_BEARER_TOKEN + ATLASSIAN_CLOUD_ID, or ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN + ATLASSIAN_DOMAIN.');
};

const jsonRequest = async (path, options = {}) => {
  const cfg = authConfig();
  const base = options.base || cfg.jiraBase;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...cfg.headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = data?.errorMessages?.join('; ') || data?.message || data?.error || text;
    throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`);
  }
  return data;
};

const confluenceRequest = (path, options = {}) => jsonRequest(path, { ...options, base: authConfig().confluenceBase });

const textFromADF = (node) => {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textFromADF).filter(Boolean).join('\n');
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return node.attrs?.text || node.attrs?.id || '';
  if (node.type === 'emoji') return node.attrs?.shortName || '';
  if (node.type === 'inlineCard' || node.type === 'blockCard') return node.attrs?.url || '';

  const content = node.content ? node.content.map(textFromADF).filter(Boolean) : [];
  if (!content.length) return '';
  const inline = content.join('');

  switch (node.type) {
    case 'doc':
      return content.join('\n\n').trim();
    case 'paragraph':
    case 'heading':
      return inline.trim();
    case 'bulletList':
      return content.map((item) => item.trim()).filter(Boolean).map((item) => `- ${item}`).join('\n');
    case 'orderedList':
      return content.map((item, index) => `${index + 1}. ${item.trim()}`).join('\n');
    case 'listItem':
      return content.join(' ').trim();
    case 'codeBlock':
      return `\`\`\`\n${inline.trim()}\n\`\`\``;
    case 'blockquote':
      return content.map((item) => `> ${item.trim()}`).join('\n');
    case 'panel':
    case 'table':
      return content.join('\n').trim();
    case 'tableRow':
      return content.join(' | ').trim();
    case 'tableCell':
    case 'tableHeader':
      return content.join(' ').trim();
    default:
      return content.join('\n').trim();
  }
};

const adfFromText = (text) => ({
  type: 'doc',
  version: 1,
  content: String(text).split(/\n{2,}/).map((paragraph) => ({
    type: 'paragraph',
    content: paragraph.split('\n').flatMap((line, index) => [
      ...(index > 0 ? [{ type: 'hardBreak' }] : []),
      { type: 'text', text: line },
    ]).filter((node) => node.text !== ''),
  })),
});

const normalizeIssue = async (issue) => {
  const comments = [];
  let startAt = 0;
  for (;;) {
    const page = await jsonRequest(`/issue/${issue.key}/comment?startAt=${startAt}&maxResults=100&orderBy=created`);
    comments.push(...(page.comments || []));
    startAt += page.maxResults || 100;
    if (startAt >= page.total) break;
  }

  return {
    key: issue.key,
    id: issue.id,
    summary: issue.fields.summary,
    type: issue.fields.issuetype?.name || null,
    status: issue.fields.status?.name || null,
    assignee: issue.fields.assignee?.displayName || null,
    reporter: issue.fields.reporter?.displayName || null,
    priority: issue.fields.priority?.name || null,
    labels: issue.fields.labels || [],
    created: issue.fields.created,
    updated: issue.fields.updated,
    descriptionText: textFromADF(issue.fields.description).replace(/\n{3,}/g, '\n\n').trim(),
    commentTotal: comments.length,
    comments: comments.map((comment) => ({
      author: comment.author?.displayName || null,
      created: comment.created,
      updated: comment.updated,
      bodyText: textFromADF(comment.body).replace(/\n{3,}/g, '\n\n').trim(),
    })),
  };
};

const commands = {
  'jira:myself': async () => {
    const user = await jsonRequest('/myself');
    return {
      ok: true,
      authMode: authConfig().mode,
      accountId: user.accountId,
      displayName: user.displayName,
      emailAddress: user.emailAddress || null,
      accountType: user.accountType || null,
      active: user.active,
    };
  },

  'jira:get': async ([issueKey]) => {
    if (!issueKey) throw new Error('Missing issue key.');
    const fields = 'summary,description,comment,status,issuetype,assignee,reporter,updated,created,priority,labels';
    const issue = await jsonRequest(`/issue/${encodeURIComponent(issueKey)}?fields=${fields}`);
    return normalizeIssue(issue);
  },

  'jira:search': async ([jql, maxResults = '10']) => {
    if (!jql) throw new Error('Missing JQL.');
    const params = new URLSearchParams({ jql, fields: 'summary,status,assignee,updated,issuetype', maxResults });
    const result = await jsonRequest(`/search/jql?${params.toString()}`);
    return {
      total: result.total ?? result.issues?.length ?? 0,
      isLast: result.isLast,
      issues: (result.issues || []).map((issue) => ({
        key: issue.key,
        summary: issue.fields.summary,
        type: issue.fields.issuetype?.name || null,
        status: issue.fields.status?.name || null,
        assignee: issue.fields.assignee?.displayName || null,
        updated: issue.fields.updated,
      })),
    };
  },

  'jira:comment': async ([issueKey, ...bodyParts]) => {
    if (!issueKey || bodyParts.length === 0) throw new Error('Usage: jira:comment ISSUE-123 "Comment body"');
    const body = bodyParts.join(' ');
    const comment = await jsonRequest(`/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      body: { body: adfFromText(body) },
    });
    return { id: comment.id, issueKey, created: comment.created, author: comment.author?.displayName || null };
  },

  'jira:transitions': async ([issueKey]) => {
    if (!issueKey) throw new Error('Missing issue key.');
    const result = await jsonRequest(`/issue/${encodeURIComponent(issueKey)}/transitions`);
    return (result.transitions || []).map((transition) => ({
      id: transition.id,
      name: transition.name,
      to: transition.to?.name || null,
    }));
  },

  'jira:transition': async ([issueKey, transitionId]) => {
    if (!issueKey || !transitionId) throw new Error('Usage: jira:transition ISSUE-123 TRANSITION_ID');
    await jsonRequest(`/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: 'POST',
      body: { transition: { id: transitionId } },
    });
    return { ok: true, issueKey, transitionId };
  },

  'confluence:search': async ([cql, limit = '10']) => {
    if (!cql) throw new Error('Missing CQL.');
    const params = new URLSearchParams({ cql, limit, expand: 'space,version' });
    const result = await confluenceRequest(`/content/search?${params.toString()}`);
    return {
      size: result.size,
      limit: result.limit,
      results: (result.results || []).map((page) => ({
        id: page.id,
        type: page.type,
        title: page.title,
        space: page.space?.key || null,
        version: page.version?.number || null,
        webui: page._links?.webui || null,
      })),
    };
  },

  'confluence:get': async ([pageId]) => {
    if (!pageId) throw new Error('Missing page ID.');
    const page = await confluenceRequest(`/content/${encodeURIComponent(pageId)}?expand=space,version,body.storage`);
    return {
      id: page.id,
      type: page.type,
      title: page.title,
      space: page.space?.key || null,
      version: page.version?.number || null,
      updated: page.version?.when || null,
      webui: page._links?.webui || null,
      storage: page.body?.storage?.value || '',
    };
  },
};

const run = async () => {
  if (!commands[command]) {
    console.error(usage);
    process.exit(2);
  }
  const result = await commands[command](args);
  console.log(JSON.stringify(result, null, 2));
};

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
