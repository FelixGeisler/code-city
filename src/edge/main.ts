import processingWorkerUrl from "./processing-worker.ts?worker&url";
import { createMainController, type AttemptView, type WorkerTransport } from "../application/main-controller";
import { createCityPresenter } from "./city-presenter";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error("Code City shell is incomplete");
  }
  return element;
}

const form = requiredElement<HTMLFormElement>("form");
const input = requiredElement<HTMLInputElement>("input[name=repository]");
const feedback = requiredElement<HTMLElement>("[data-feedback]");
const status = requiredElement<HTMLElement>("[data-status]");
const commit = requiredElement<HTMLOutputElement>("[data-commit]");
const city = requiredElement<HTMLElement>("[data-city]");

function replaceStatus(message: string, cancel?: () => void): void {
  const text = document.createElement("p");
  text.setAttribute("role", "status");
  text.textContent = message;
  if (!cancel) {
    status.replaceChildren(text);
    return;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Cancel";
  button.addEventListener("click", cancel, { once: true });
  status.replaceChildren(text, button);
}

const view: AttemptView = {
  clear() {
    feedback.textContent = "";
    status.replaceChildren();
    commit.textContent = "";
  },
  invalid() {
    feedback.textContent = "Invalid input";
  },
  working(cancel) {
    replaceStatus("Working", cancel);
  },
  success(revision) {
    status.replaceChildren();
    commit.textContent = revision;
  },
  failure: (category, code, revision) => {
    commit.textContent = revision ?? "";
    replaceStatus(code ? `${category} (${code})` : category);
  },
  cancelled: () => {
    commit.textContent = "";
    replaceStatus("Cancelled");
  },
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

const controller = createMainController(createWorkerTransport, view, (hooks) => createCityPresenter({
  host: city,
  isEligible: hooks.isEligible,
  failed: hooks.failed,
}));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  controller.submit(input.value);
});
window.addEventListener("pagehide", () => controller.dispose(), { once: true });
