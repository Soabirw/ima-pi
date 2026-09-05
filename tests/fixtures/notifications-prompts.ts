import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";

type SelectKeybindings = Pick<KeybindingsManager, "matches">;

const isInteractiveTui = (ctx: Pick<ExtensionContext, "mode" | "hasUI">): boolean =>
  ctx.mode === "tui" && ctx.hasUI;

const closeOnEnterOrEscape = (
  keybindings: SelectKeybindings,
  done: () => void,
) => (data: string): void => {
  if (
    keybindings.matches(data, "tui.select.confirm")
    || keybindings.matches(data, "tui.select.cancel")
  ) {
    done();
  }
};

const showCustomPrompt = async (ctx: ExtensionContext): Promise<void> => {
  await ctx.ui.custom<void>((_tui, _theme, keybindings, done) => ({
    render: () => ["Notification fixture custom prompt — use confirm or cancel to close."],
    invalidate: () => {},
    handleInput: closeOnEnterOrEscape(keybindings, () => done(undefined)),
  }));
};

const showNestedPrompt = async (ctx: ExtensionContext): Promise<void> => {
  await ctx.ui.custom<void>((_tui, _theme, keybindings, done) => {
    let innerStarted = false;
    let closed = false;

    const closeOnce = (): void => {
      if (closed) return;
      closed = true;
      try {
        done(undefined);
      } catch {
        // A fixture completion failure must not leave a rejected background task.
      }
    };

    const openNestedConfirmation = (): void => {
      if (innerStarted || closed) return;
      innerStarted = true;

      try {
        void ctx.ui
          .confirm(
            "Nested notification fixture",
            "Close this inner confirmation to close the outer custom prompt.",
          )
          .then(closeOnce, closeOnce);
      } catch {
        closeOnce();
      }
    };

    return {
      render: () => [
        "Nested notification fixture — confirm opens the inner dialog; cancel closes.",
      ],
      invalidate: () => {},
      handleInput: (data: string): void => {
        if (keybindings.matches(data, "tui.select.cancel")) {
          if (!innerStarted) closeOnce();
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm")) {
          openNestedConfirmation();
        }
      },
    };
  });
};

export default function notificationPromptFixture(pi: ExtensionAPI): void {
  pi.registerCommand("ima:notification-prompts", {
    description: "Manual notification fixture for extension prompt events.",
    handler: async (_args, ctx) => {
      if (!isInteractiveTui(ctx)) return;

      await ctx.ui.confirm(
        "Notification fixture confirmation",
        "Confirm or cancel this prompt.",
      );
      await ctx.ui.select("Notification fixture selection", ["Continue", "Cancel"]);
      await ctx.ui.input("Notification fixture input", "Enter any text");
      await ctx.ui.editor("Notification fixture editor", "Edit this text");
      await showCustomPrompt(ctx);
      await showNestedPrompt(ctx);
    },
  });
}
