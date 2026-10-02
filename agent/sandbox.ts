import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

// Bake browser dependencies into the image once; live sessions have no integration secrets.
export const environment = DockerSandbox.dockerfile();
export default defineSandbox(() => environment.open({ networkPolicy: "allow-all" }));
