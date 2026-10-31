/** Resolve after native close handlers, not merely removal of the open attribute. */
export function closeDialogAndWait(dialog, activate) {
  if (!dialog) return Promise.reject(new Error("Expected a native dialog"));
  if (!dialog.open) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const closed = () => resolve();
    dialog.addEventListener("close", closed, { once: true });
    try { activate(); }
    catch (error) { dialog.removeEventListener("close", closed); reject(error); }
  });
}
