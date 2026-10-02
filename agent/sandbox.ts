import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";
import { installAgentBrowser } from "@agent-browser/eve/sandbox";

export const environment = DockerSandbox.dockerfile({
  prepare: async (sandbox) => {
    await installAgentBrowser({ id: "preparation", run: (options) => sandbox.run(options) });
  },
});
export default defineSandbox(() => environment.open({ networkPolicy: "allow-all" }));
