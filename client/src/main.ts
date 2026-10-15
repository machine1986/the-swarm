import { App } from "./app/App.ts";
import "./style.css";

const app = new App();
app.start(document.getElementById("stage")!).catch((err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div style="position:fixed;inset:0;display:grid;place-items:center;font-family:monospace;color:#ff315a">
       WebGL initialisation failed: ${String((err as Error)?.message ?? err)}
     </div>`,
  );
});

// Handy for debugging in the console.
(window as unknown as { swarm: App }).swarm = app;
