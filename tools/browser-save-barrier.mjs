/** Await Save's own UI result, independently of retained inspection failures.
 * Serialized into the packaged page; the caller retains its existing watchdog.
 */
export function waitForSave(documentTarget, locationTarget) {
  return new Promise((resolve, reject) => {
    let observer;
    const check = () => {
      const message = documentTarget.querySelector('[data-save-status]').textContent;
      const presentation = documentTarget.querySelector('[data-status]').textContent;
      if (presentation.startsWith('Presentation failed')) {
        observer?.disconnect(); reject(new Error(presentation));
      } else if (message.includes('unchanged')) {
        observer?.disconnect(); resolve({ saved: false, saveMessage: message });
      } else if (message === 'Saved'
        && documentTarget.querySelector('[data-save]').hidden
        && /^\/saved\/[A-Za-z0-9_-]{43}$/u.test(locationTarget.pathname)) {
        observer?.disconnect(); resolve({ saved: true, saveMessage: message });
      }
    };
    observer = new MutationObserver(check);
    observer.observe(documentTarget, { subtree: true, childList: true, attributes: true, characterData: true });
    check();
  });
}
