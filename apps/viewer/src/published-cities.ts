import type {
  PublishedCitiesApi,
  PublishedCityCurrentModel,
  PublishedCityVersionView,
  PublishedCityView,
} from "./published-cities-api.js";

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing required element #${id}.`);
  }
  return element as T;
}

export interface PublishedCitiesDialogHandle {
  open(): Promise<void>;
  dispose(): void;
}

export function installPublishedCitiesDialog(options: {
  readonly api: PublishedCitiesApi;
  readonly currentModel: () => PublishedCityCurrentModel;
  readonly onOpen: (publication: PublishedCityView, version: PublishedCityVersionView) => void | Promise<void>;
}): PublishedCitiesDialogHandle {
  const dialog = requiredElement<HTMLDialogElement>("published-cities-dialog");
  const close = requiredElement<HTMLButtonElement>("published-cities-close");
  const title = requiredElement<HTMLInputElement>("published-city-title");
  const description = requiredElement<HTMLTextAreaElement>("published-city-description");
  const submit = requiredElement<HTMLButtonElement>("published-city-submit");
  const status = requiredElement<HTMLElement>("published-city-status");
  const search = requiredElement<HTMLInputElement>("published-city-search");
  const sort = requiredElement<HTMLSelectElement>("published-city-sort");
  const listStatus = requiredElement<HTMLElement>("published-city-list-status");
  const list = requiredElement<HTMLUListElement>("published-city-list");
  let controller: AbortController | undefined;
  let publications: readonly PublishedCityView[] = [];
  let disposed = false;

  const render = (): void => {
    list.replaceChildren();
    const query = search.value.normalize("NFC").trim().toLocaleLowerCase();
    const visible = publications
      .filter((publication) =>
        query === "" ||
        publication.title.toLocaleLowerCase().includes(query) ||
        publication.description?.toLocaleLowerCase().includes(query),
      )
      .toSorted((left, right) =>
        sort.value === "title"
          ? left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
          : right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      );
    listStatus.textContent = publications.length === 0
      ? "No cities have been published yet."
      : query !== ""
        ? `${visible.length.toLocaleString()} of ${publications.length.toLocaleString()} published cities match.`
        : `${publications.length.toLocaleString()} published ${publications.length === 1 ? "city" : "cities"}.`;
    for (const publication of visible) {
      const latest = publication.versions.find(({ id }) => id === publication.latestVersionId)!;
      const item = document.createElement("li");
      const heading = document.createElement("strong");
      heading.textContent = publication.title;
      const freshness = document.createElement("span");
      freshness.textContent =
        `Generated ${new Date(latest.generatedAt).toLocaleString()} · published ${new Date(latest.publishedAt).toLocaleString()}` +
        (latest.modelVersion === undefined ? "" : ` · ${latest.modelVersion}`) +
        ` · ${latest.buildingCount.toLocaleString()} buildings` +
        (latest.evolution === undefined ? "" : ` · ${latest.evolution.frameCount.toLocaleString()} history frames`);
      const notice = document.createElement("small");
      notice.textContent = "Not automatically updated.";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "button";
      open.textContent = "Open latest";
      open.addEventListener("click", () => void options.onOpen(publication, latest));
      const share = document.createElement("a");
      share.className = "button";
      share.href = publication.latestUrl;
      share.textContent = "Open share link";
      const history = document.createElement("details");
      const historySummary = document.createElement("summary");
      historySummary.textContent = `${publication.versions.length.toLocaleString()} immutable ${publication.versions.length === 1 ? "version" : "versions"}`;
      const versionList = document.createElement("ul");
      for (const version of publication.versions) {
        const versionItem = document.createElement("li");
        const versionLink = document.createElement("a");
        versionLink.href = version.viewerUrl;
        versionLink.textContent =
          `${new Date(version.publishedAt).toLocaleString()}` +
          (version.modelVersion === undefined ? "" : ` · ${version.modelVersion}`);
        versionItem.append(versionLink);
        versionList.append(versionItem);
      }
      history.append(historySummary, versionList);
      const republish = document.createElement("button");
      republish.type = "button";
      republish.className = "button";
      republish.textContent = "Publish current as new version";
      republish.disabled = options.currentModel().jobId === undefined;
      republish.addEventListener("click", () => void publish(publication.id));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button";
      remove.textContent = "Unpublish";
      let removalConfirmed = false;
      remove.addEventListener("click", () => {
        if (!removalConfirmed) {
          removalConfirmed = true;
          remove.textContent = "Confirm unpublish";
          status.textContent =
            "Confirm unpublish to revoke the latest and all immutable version links.";
          return;
        }
        void removePublication(publication.id);
      });
      item.append(
        heading,
        freshness,
        notice,
        open,
        share,
        history,
        republish,
        remove,
      );
      list.append(item);
    }
  };

  const refresh = async (): Promise<void> => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    listStatus.textContent = "Loading published cities…";
    try {
      publications = await options.api.list(current.signal);
      if (!current.signal.aborted) render();
    } catch {
      if (!current.signal.aborted) listStatus.textContent = "Published cities could not be loaded.";
    }
  };

  const publish = async (publicationId?: string): Promise<void> => {
    const current = options.currentModel();
    if (current.jobId === undefined) {
      status.textContent = "Import and open a completed city before publishing.";
      return;
    }
    submit.disabled = true;
    status.textContent = "Publishing immutable snapshot…";
    try {
      const publication = await options.api.publish({
        jobId: current.jobId,
        title: title.value.trim() || current.title,
        ...(description.value.trim() === "" ? {} : { description: description.value.trim() }),
        ...(publicationId === undefined ? {} : { publicationId }),
      });
      status.textContent = `Published ${publication.title}. The latest link now opens this immutable version.`;
      await refresh();
    } catch {
      status.textContent = "The current city could not be published. Sign in and retry.";
    } finally {
      submit.disabled = false;
    }
  };

  const removePublication = async (publicationId: string): Promise<void> => {
    status.textContent = "Removing publication…";
    try {
      await options.api.remove(publicationId);
      status.textContent = "Publication removed.";
      await refresh();
    } catch {
      status.textContent = "Publication could not be removed. Sign in and retry.";
    }
  };

  search.addEventListener("input", render);
  sort.addEventListener("change", render);
  submit.addEventListener("click", () => void publish());
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dialog.close();
  });

  return {
    async open(): Promise<void> {
      if (disposed) return;
      const current = options.currentModel();
      title.value = current.title;
      submit.disabled = current.jobId === undefined;
      status.textContent = current.jobId === undefined
        ? "Import and open a completed city to publish it. You can still view existing snapshots."
        : "Publishing creates a permanent snapshot; it will not update automatically.";
      dialog.showModal();
      await refresh();
    },
    dispose(): void {
      disposed = true;
      controller?.abort();
      if (dialog.open) dialog.close();
    },
  };
}
