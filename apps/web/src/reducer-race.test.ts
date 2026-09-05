import { describe, expect, it } from "vitest";
import { initialState, reducer } from "./App";
import type { DashboardResponse } from "./types";

function response(revision: number): DashboardResponse {
  return {
    draft: {
      ...initialState.dashboard,
      revision,
      name: `server-${revision}`
    },
    draftRevision: revision,
    publishedRevision: null,
    snapshot: null,
    lastError: null,
    displayTokenConfigured: false,
    lastDisplayRequestAt: null
  };
}

describe("editor reducer races", () => {
  it("does not overwrite newer edits when an older save returns", () => {
    const dirty = reducer(initialState, {
      type: "mutate",
      dashboard: { ...initialState.dashboard, name: "newer-local-edit" }
    });

    const saved = reducer(dirty, {
      type: "saved",
      payload: response(2),
      editorRevision: initialState.editorRevision
    });

    expect(saved.dashboard.name).toBe("newer-local-edit");
    expect(saved.savedRevision).toBe(2);
    expect(saved.draftStatus).toBe("dirty");
    expect(saved.editorRevision).toBe(dirty.editorRevision);
  });

  it("uses the completed publish job revision instead of current saved revision", () => {
    const state = {
      ...initialState,
      savedRevision: 12,
      publishedRevision: 4
    };

    const published = reducer(state, {
      type: "publishDone",
      job: { id: "job-1", kind: "publish", status: "succeeded", revision: 9 }
    });

    expect(published.publishedRevision).toBe(9);
    expect(published.publish.message).toContain("9");
  });

  it("loads an older published snapshot as stale when the draft is newer", () => {
    const loaded = reducer(initialState, {
      type: "load",
      payload: {
        ...response(5),
        publishedRevision: 3,
        snapshot: {
          revision: 3,
          url: "/api/snapshots/published-3.png",
          generatedAt: "2026-09-05T00:00:00.000Z",
          width: 800,
          height: 1200
        }
      }
    });

    expect(loaded.preview.status).toBe("superseded");
    expect(loaded.preview.editorRevision).toBe(3);
    expect(loaded.preview.url).toBe("/api/snapshots/published-3.png");
    expect(loaded.preview.message).toContain("当前草稿待预览");
  });

  it("marks the existing preview stale after undo changes the draft", () => {
    const previous = { ...initialState.dashboard, name: "previous-draft" };
    const state = {
      ...initialState,
      preview: {
        status: "ready" as const,
        url: "/api/previews/current.png",
        editorRevision: 4,
        message: "PNG 预览已更新"
      },
      undoStack: [previous]
    };

    const undone = reducer(state, { type: "undo" });

    expect(undone.dashboard.name).toBe("previous-draft");
    expect(undone.preview.status).toBe("superseded");
    expect(undone.preview.url).toBe("/api/previews/current.png");
    expect(undone.preview.message).toBe("布局已修改，预览待更新");
  });
});
