import processingWorkerUrl from "./processing-worker.ts?worker&url";
import { createMainController, type AttemptView, type WorkerTransport } from "../application/main-controller";
import { createCityPresenter, type PresenterToken } from "./city-presenter";
import { stageSemanticPublication } from "./semantic-publication";

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
const cityReset = requiredElement<HTMLButtonElement>("[data-city-reset]");

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
  stagePublication(revision, inspection) {
    return stageSemanticPublication(document, city, commit, revision, inspection);
  },
};

export function createWorkerTransport(
  worker: Worker = new Worker(processingWorkerUrl, { type: "module" }),
): WorkerTransport {
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
      const attached: Array<() => void> = [];
      let detached = false;
      const detach = () => {
        if (detached) {
          return;
        }
        detached = true;
        for (const remove of attached) {
          try {
            remove();
          } catch {}
        }
      };
      try {
        worker.addEventListener("message", message);
        attached.push(() => worker.removeEventListener("message", message));
        worker.addEventListener("error", error);
        attached.push(() => worker.removeEventListener("error", error));
        worker.addEventListener("messageerror", messageError);
        attached.push(() => worker.removeEventListener("messageerror", messageError));
      } catch (error) {
        detach();
        throw error;
      }
      return detach;
    },
  };
}

const controller = createMainController(createWorkerTransport, view, (hooks) => {
  const presenter = createCityPresenter({
    host: city,
    resetControl: cityReset,
    isEligible: hooks.isEligible,
    failed: hooks.failed,
  });
  return {
    stage: presenter.stage,
    commit: (token) => presenter.commit(token as PresenterToken),
    rollback: (token) => presenter.rollback(token as PresenterToken),
    setVisualState: presenter.setVisualState,
    dispose: presenter.dispose,
  };
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  controller.submit(input.value);
});
window.addEventListener("pagehide", () => controller.dispose(), { once: true });
