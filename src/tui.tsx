import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { createFooterController } from "./footer.ts";

export default Plugin.define({
  id: "opencode-quota-footer",
  setup(ctx) {
    return ctx.ui.slot({
      append: "prompt.footer",
      render(props) {
        const [text, setText] = createSignal("Codex unavailable");
        const controller = createFooterController(ctx, setText);
        onCleanup(() => controller.dispose());
        createEffect(() => controller.update(props.sessionID, ctx.ui.model.current()?.providerID));
        return <text fg={ctx.theme.text.base}>{text()}</text>;
      },
    });
  },
});
