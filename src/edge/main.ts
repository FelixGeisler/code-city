import processingWorkerUrl from "./processing-worker.ts?worker&url";
import { createMainController, type AttemptView, type WorkerTransport } from "../application/main-controller";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error("Code City shell is incomplete");
  }
  return element;
}

const surface = requiredElement<HTMLElement>("[data-surface]");
const form = requiredElement<HTMLFormElement>("form");
const input = requiredElement<HTMLInputElement>("input[name=repository]");
const feedback = requiredElement<HTMLElement>("[data-feedback]");

function terminal(message: string): void {
  surface.replaceChildren();
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = message;
  surface.append(status);
}

const view: AttemptView = {
  invalid() {
    feedback.textContent = "Invalid input";
  },
  working(cancel) {
    surface.replaceChildren();
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = "Resolving immutable revision…";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Cancel";
    button.addEventListener("click", cancel, { once: true });
    surface.append(status, button);
  },
  failure: terminal,
  cancelled: () => terminal("Cancelled"),
};

function createWorkerTransport(): WorkerTransport {
  const worker = new Worker(processingWorkerUrl, { type: "module" });
  return {
    send: (command) => worker.postMessage(command),
    close: () => worker.terminate(),
    listen(handlers) {
      const message = (event: MessageEvent<unknown>) => handlers.message(event.data);
      const error = (event: ErrorEvent) => {
        event.preventDefault();
        handlers.crash();
      };
      const messageError = () => handlers.messageError();
      worker.addEventListener("message", message);
      worker.addEventListener("error", error);
      worker.addEventListener("messageerror", messageError);
      return () => {
        worker.removeEventListener("message", message);
        worker.removeEventListener("error", error);
        worker.removeEventListener("messageerror", messageError);
      };
    },
  };
}

const controller = createMainController(createWorkerTransport, view);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  controller.submit(input.value);
});
