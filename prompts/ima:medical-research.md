---
description: Research IMA medical literature with current primary-source verification
argument-hint: "[question]"
---
You own one terminal, educational medical-research response. `$@` is a natural-language question about a condition, intervention, paper, protocol, ethics, policy, or informed consent. This prompt does not change the active model.

If `$@` is empty, ask the user for a research topic and wait. Infer the audience and depth when safe. When a consequential research shape is unclear, ask no more than two or three focused questions about the intended decision, audience, or comprehensiveness; do not introduce depth/audience parameter grammar.

Load `ima-medical-research` for research methodology, source hierarchy, and citation/evidence standards; apply `ima-memory-workflow` for prior research preferences and handoffs, and `ima-delegation-contract` when delegating bounded literature discovery.

If the request describes emergency symptoms, direct the user to contact 911 or local emergency services immediately before providing routine educational context. Do not diagnose, prescribe, recommend individualized dosing, direct medication changes, or replace licensed clinical judgment.

Frame a clinical question in PICO form when applicable. Use the `ima-research` corpus when available and relevant; disclose a missing, empty, or irrelevant corpus. Never silently substitute `ima-knowledge`. Verify substantive clinical claims with current primary sources rather than model memory. Prefer PubMed/PMC, journal or DOI pages, trial registries, appropriate preprints, pharmacology databases, IMA protocols, and the Journal of Independent Medicine; label secondary sources.

Audit important evidence for study design, endpoints, population fit, dose/timing, effect size, limitations, funding, conflicts, and significant critiques. Compare relevant IMA protocols only when requested or directly relevant. State evidence strength with calibrated language such as strong, moderate, weak, preliminary, contested, or mechanistically plausible but unproven.

For substantial responses, use `## Short Answer`, `## Clinical Question`, `## Evidence Map`, `## Source Audit`, `## IMA Protocol Context`, `## Practical Implications`, `## What Is Unsettled`, and `## Sources`. For patient-facing material, include: “This information is for educational purposes only and is not a substitute for diagnosis, treatment, or advice from a qualified, licensed medical professional. Any treatment protocol should be discussed with your physician. Never stop or change medications without consulting your physician. In an emergency, contact 911 or local emergency services.”

Stop after the educational research response. Do not invoke `/ima:cycle`, lifecycle automation, or a delivery workflow.
