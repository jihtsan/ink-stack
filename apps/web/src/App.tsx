import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createDefaultDashboard } from "@ink-stack/shared";
import { api, ApiError } from "./api";
import { CanvasInspector } from "./CanvasInspector";
import { StudioIcon } from "./StudioIcon";
import { getWidgetDefinition, widgetCatalog } from "./catalog";
import {
  canPlace,
  cloneDashboard,
  computePixelRect,
  findFirstAvailablePlacement,
  moveIfValid,
  replaceDashboardIfValid,
  resizeIfValid,
  snapPointerToGrid,
  updateWidget,
  validateLayout
} from "./grid";
import { WidgetCanvas, type DragState, type LibraryDropState } from "./WidgetCanvas";
import type {
  CalendarConfig,
  CodexConnectionResponse,
  CodexConnectionTestResponse,
  CodexUsageConfig,
  DashboardDraft,
  DashboardResponse,
  DateConfig,
  ImageConfig,
  JobResponse,
  JsonObject,
  PublicWidgetDefinition,
  TextConfig,
  TodoConfig,
  WeatherConfig,
  WidgetInstance,
  WidgetSize,
  WidgetType
} from "./types";

type LoadState = "checking" | "login" | "ready";
type DraftStatus = "clean" | "dirty" | "saving" | "conflict";
type NoticeKind = "info" | "success" | "warning" | "error";

type Notice = {
  kind: NoticeKind;
  message: string;
};

type PreviewState = {
  status: "idle" | "queued" | "running" | "ready" | "failed" | "superseded";
  url: string | null;
  editorRevision: number | null;
  message: string;
};

type PublishState = {
  status: "idle" | "queued" | "running" | "ready" | "failed" | "superseded";
  message: string;
};

type EditorState = {
  dashboard: DashboardDraft;
  selectedId: string | null;
  editorRevision: number;
  savedRevision: number;
  publishedRevision: number | null;
  snapshotUrl: string | null;
  displayUrl: string | null;
  displayTokenConfigured: boolean;
  draftStatus: DraftStatus;
  preview: PreviewState;
  publish: PublishState;
  notice: Notice | null;
  undoStack: DashboardDraft[];
  lastDisplayRequestAt: string | null;
  lastServerError: string | null;
};

type EditorAction =
  | { type: "load"; payload: DashboardResponse }
  | { type: "select"; widgetId: string | null }
  | { type: "mutate"; dashboard: DashboardDraft; selectedId?: string | null; notice?: Notice }
  | { type: "saving" }
  | { type: "saved"; payload: DashboardResponse; editorRevision: number }
  | { type: "conflict"; message: string }
  | { type: "setNotice"; notice: Notice | null }
  | { type: "undo" }
  | { type: "previewQueued"; editorRevision: number; job: JobResponse }
  | { type: "previewDone"; job: JobResponse }
  | { type: "publishQueued"; job: JobResponse }
  | { type: "publishDone"; job: JobResponse }
  | { type: "jobFailed"; kind: "preview" | "publish"; message: string }
  | { type: "displayToken"; url: string };

const LIBRARY_DRAG_MIME = "application/x-inkstack-widget";

const emptyPreview: PreviewState = {
  status: "idle",
  url: null,
  editorRevision: null,
  message: "尚未生成预览"
};

const emptyPublish: PublishState = {
  status: "idle",
  message: "发布只使用已保存修订"
};

function markPreviewStale(preview: PreviewState): PreviewState {
  return preview.url
    ? { ...preview, status: "superseded", message: "布局已修改，预览待更新" }
    : preview;
}

const initialDashboard: DashboardDraft = createDefaultDashboard({
  id: "main",
  name: "我的仪表盘",
  revision: 0,
  timeZone: "Asia/Shanghai",
  screen: { width: 800, height: 1200 },
  grid: {
    columns: 4,
    rows: 6,
    columnGap: 16,
    rowGap: 16,
    margin: { top: 32, right: 32, bottom: 32, left: 32 }
  },
  theme: {
    background: "#ffffff",
    foreground: "#111111",
    muted: "#666666",
    border: "#222222"
  },
  widgets: [
    {
      id: "date-initial",
      type: "date",
      configVersion: 1,
      column: 0,
      row: 0,
      columnSpan: 4,
      rowSpan: 1,
      config: { subtitle: "今天", format: "full", showWeekday: true }
    },
    {
      id: "codex-initial",
      type: "codex-usage",
      configVersion: 1,
      column: 0,
      row: 1,
      columnSpan: 2,
      rowSpan: 4,
      config: {
          alias: "工作账号",
          connectionId: "local-codex-app-server",
          connectionRevision: 1,
          quotaGroupId: "codex",
          lowBalanceThreshold: 20
      }
    },
    {
      id: "todo-initial",
      type: "todo",
      configVersion: 1,
      column: 2,
      row: 1,
      columnSpan: 2,
      rowSpan: 4,
      config: {
        title: "待办事项",
        items: [
          { id: "todo-a", text: "检查中文 PNG", done: false },
          { id: "todo-b", text: "保存草稿", done: false },
          { id: "todo-c", text: "发布前预览", done: true }
        ],
        sort: "open-first",
        maxVisible: 6
      }
    },
    {
      id: "text-initial",
      type: "text",
      configVersion: 1,
      column: 0,
      row: 5,
      columnSpan: 4,
      rowSpan: 1,
      config: {
        title: "墨栈",
        text: "专注当下，持续迭代。",
        size: "medium",
        align: "center",
        showBorder: true,
        showBackground: true
      }
    }
  ]
});

export function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load":
      const snapshotRevision = action.payload.snapshot?.revision ?? action.payload.publishedRevision;
      const hasNewerDraft =
        snapshotRevision !== null &&
        snapshotRevision !== undefined &&
        action.payload.draftRevision > snapshotRevision;
      return {
        ...state,
        dashboard: action.payload.draft,
        selectedId: action.payload.draft.widgets[0]?.id ?? null,
        editorRevision: action.payload.draftRevision,
        savedRevision: action.payload.draftRevision,
        publishedRevision: action.payload.publishedRevision,
        snapshotUrl: action.payload.snapshot?.url ?? null,
        displayUrl: action.payload.displayTokenConfigured ? state.displayUrl : null,
        displayTokenConfigured: action.payload.displayTokenConfigured,
        draftStatus: "clean",
        preview: action.payload.snapshot?.url
          ? {
              status: hasNewerDraft ? "superseded" : "ready",
              url: action.payload.snapshot.url,
              editorRevision: snapshotRevision ?? null,
              message: hasNewerDraft
                ? `已发布旧图修订 ${snapshotRevision}；当前草稿待预览`
                : `已发布修订 ${snapshotRevision}`
            }
          : emptyPreview,
        lastDisplayRequestAt: action.payload.lastDisplayRequestAt,
        lastServerError: action.payload.lastError
      };
    case "select":
      return { ...state, selectedId: action.widgetId };
    case "mutate":
      return {
        ...state,
        dashboard: action.dashboard,
        selectedId: action.selectedId === undefined ? state.selectedId : action.selectedId,
        editorRevision: state.editorRevision + 1,
        draftStatus: "dirty",
        preview: markPreviewStale(state.preview),
        notice: action.notice ?? null,
        undoStack: [cloneDashboard(state.dashboard), ...state.undoStack].slice(0, 20)
      };
    case "saving":
      return { ...state, draftStatus: "saving", notice: { kind: "info", message: "正在保存草稿" } };
    case "saved":
      if (action.editorRevision < state.editorRevision) {
        return {
          ...state,
          savedRevision: action.payload.draftRevision,
          publishedRevision: action.payload.publishedRevision,
        snapshotUrl: action.payload.snapshot?.url ?? state.snapshotUrl,
          displayTokenConfigured: action.payload.displayTokenConfigured,
          draftStatus: "dirty",
          notice: {
            kind: "success",
            message: `草稿修订 ${action.payload.draftRevision} 已保存；当前编辑仍有未保存修改`
          },
          lastServerError: action.payload.lastError
        };
      }
      return {
        ...state,
        dashboard: action.payload.draft,
        editorRevision: Math.max(state.editorRevision, action.editorRevision),
        savedRevision: action.payload.draftRevision,
        publishedRevision: action.payload.publishedRevision,
        snapshotUrl: action.payload.snapshot?.url ?? state.snapshotUrl,
        displayTokenConfigured: action.payload.displayTokenConfigured,
        draftStatus: "clean",
        notice: { kind: "success", message: `草稿已保存为修订 ${action.payload.draftRevision}` },
        lastServerError: action.payload.lastError
      };
    case "conflict":
      return {
        ...state,
        draftStatus: "conflict",
        notice: { kind: "warning", message: action.message }
      };
    case "setNotice":
      return { ...state, notice: action.notice };
    case "undo": {
      const [previous, ...rest] = state.undoStack;
      if (!previous) {
        return { ...state, notice: { kind: "info", message: "没有可撤销的操作" } };
      }
      return {
        ...state,
        dashboard: previous,
        selectedId: previous.widgets.some((widget) => widget.id === state.selectedId)
          ? state.selectedId
          : previous.widgets[0]?.id ?? null,
        editorRevision: state.editorRevision + 1,
        draftStatus: "dirty",
        preview: markPreviewStale(state.preview),
        undoStack: rest,
        notice: { kind: "success", message: "已撤销上一步" }
      };
    }
    case "previewQueued":
      return {
        ...state,
        preview: {
          status: action.job.status === "running" ? "running" : "queued",
          url: state.preview.url,
          editorRevision: action.editorRevision,
          message: "服务端正在生成 PNG 预览"
        },
        notice: { kind: "info", message: "预览任务已提交" }
      };
    case "previewDone":
      if (
        action.job.editorRevision !== undefined &&
        action.job.editorRevision < state.editorRevision
      ) {
        return {
          ...state,
          preview: { ...state.preview, status: "superseded", message: "旧预览已忽略" }
        };
      }
      if (action.job.status === "succeeded" && action.job.previewUrl) {
        return {
          ...state,
          preview: {
            status: "ready",
            url: action.job.previewUrl,
            editorRevision: action.job.editorRevision ?? state.editorRevision,
            message: "PNG 预览已更新"
          },
          notice: { kind: "success", message: "PNG 预览已更新" }
        };
      }
      return {
        ...state,
        preview: {
          ...state.preview,
          status: action.job.status === "succeeded" ? "ready" : action.job.status,
          message: action.job.error ?? `预览任务状态：${action.job.status}`
        },
        notice:
          action.job.status === "failed"
            ? { kind: "error", message: action.job.error ?? "预览生成失败" }
            : state.notice
      };
    case "publishQueued":
      return {
        ...state,
        publish: { status: action.job.status === "running" ? "running" : "queued", message: "发布任务已提交" },
        notice: { kind: "info", message: "发布任务已提交" }
      };
    case "publishDone":
      if (action.job.status === "succeeded") {
        const publishedRevision = action.job.revision ?? state.publishedRevision;
        return {
          ...state,
          publishedRevision,
          snapshotUrl: action.job.previewUrl ?? state.snapshotUrl,
          publish: { status: "ready", message: `已发布修订 ${publishedRevision ?? "未知"}` },
          notice: { kind: "success", message: "发布完成，旧有效图片已被新快照替换" }
        };
      }
      return {
        ...state,
        publish: {
          status: action.job.status,
          message: action.job.error ?? `发布任务状态：${action.job.status}`
        },
        notice:
          action.job.status === "failed"
            ? { kind: "error", message: action.job.error ?? "发布失败，已保留旧图片" }
            : state.notice
      };
    case "jobFailed":
      return {
        ...state,
        preview:
          action.kind === "preview"
            ? { ...state.preview, status: "failed", message: action.message }
            : state.preview,
        publish:
          action.kind === "publish"
            ? { status: "failed", message: action.message }
            : state.publish,
        notice: { kind: "error", message: action.message }
      };
    case "displayToken":
      return {
        ...state,
        displayUrl: action.url,
        displayTokenConfigured: true,
        notice: { kind: "success", message: "图片地址已创建，请妥善保存" }
      };
    default:
      return state;
  }
}

export const initialState: EditorState = {
  dashboard: initialDashboard,
  selectedId: initialDashboard.widgets[0]?.id ?? null,
  editorRevision: 0,
  savedRevision: 0,
  publishedRevision: null,
  snapshotUrl: null,
  displayUrl: null,
  displayTokenConfigured: false,
  draftStatus: "dirty",
  preview: emptyPreview,
  publish: emptyPublish,
  notice: null,
  undoStack: [],
  lastDisplayRequestAt: null,
  lastServerError: null
};

function makeId(type: WidgetType): string {
  return `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function cloneConfig<T>(config: T): T {
  return structuredClone(config) as T;
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "无记录";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function sizeLabel(size: WidgetSize): string {
  return `${size.columns} x ${size.rows}`;
}

function ensureNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toJsonObject(value: JsonObject): JsonObject {
  return value;
}

function widgetIcon(type: string): string {
  if (type === "text") {
    return "text_fields";
  }
  if (type === "date") {
    return "calendar_month";
  }
  if (type === "todo") {
    return "check_circle";
  }
  if (type === "calendar") {
    return "calendar_month";
  }
  if (type === "image") {
    return "visibility";
  }
  if (type === "weather") {
    return "info";
  }
  return "terminal";
}

function renderJobStatus(status: PreviewState["status"] | PublishState["status"]): string {
  const labels: Record<PreviewState["status"] | PublishState["status"], string> = {
    idle: "待生成",
    queued: "排队中",
    running: "生成中",
    ready: "已完成",
    failed: "失败",
    superseded: "已过期"
  };
  return labels[status];
}

function renderCodexStatus(status: CodexConnectionTestResponse["status"]): string {
  const labels: Record<CodexConnectionTestResponse["status"], string> = {
    ok: "已读取",
    codex_not_found: "未找到 Codex",
    not_logged_in: "未登录",
    unsupported_auth: "当前登录方式不支持额度",
    rate_limits_unavailable: "额度不可用",
    timeout: "读取超时",
    protocol_error: "协议错误",
    process_error: "进程错误",
    response_too_large: "响应过大"
  };
  return labels[status];
}

export default function App() {
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryCategory, setLibraryCategory] = useState("all");
  const [librarySize, setLibrarySize] = useState("all");
  const [inspectorTab, setInspectorTab] = useState<"properties" | "canvas" | "device">("properties");
  const [canvasMode, setCanvasMode] = useState<"layout" | "preview">("layout");
  const [showGrid, setShowGrid] = useState(true);
  const [zoom, setZoom] = useState<"fit" | "100">("fit");
  const [loadState, setLoadState] = useState<LoadState>("checking");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [libraryDrop, setLibraryDrop] = useState<LibraryDropState | null>(null);
  const [codexSources, setCodexSources] = useState<CodexConnectionResponse>({
    connections: [],
    groups: [],
    lastRead: null
  });
  const [connectionDraftName, setConnectionDraftName] = useState("本机 Codex");
  const [connectionTest, setConnectionTest] = useState<CodexConnectionTestResponse | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const libraryDragRef = useRef<PublicWidgetDefinition | null>(null);
  const connectionTestSeq = useRef(0);

  const selectedWidget = useMemo(
    () => state.dashboard.widgets.find((widget) => widget.id === state.selectedId) ?? null,
    [state.dashboard.widgets, state.selectedId]
  );
  const selectedDefinition = selectedWidget ? getWidgetDefinition(selectedWidget.type) : null;
  const layoutIssues = useMemo(() => validateLayout(state.dashboard), [state.dashboard]);
  const selectedIssue = layoutIssues.find((issue) => issue.widgetId === state.selectedId);
  const canPublish = state.draftStatus === "clean" && state.savedRevision > 0;

  const refreshDashboard = useCallback(async () => {
    const response = await api.getDashboard();
    dispatch({ type: "load", payload: response });
  }, []);

  const refreshCodexSources = useCallback(async () => {
    try {
      const response = await api.listCodexConnections();
      dispatch({ type: "setNotice", notice: null });
      setCodexSources(response);
    } catch (error) {
      setCodexSources({ connections: [], groups: [], lastRead: null });
      dispatch({
        type: "setNotice",
        notice: {
          kind: "warning",
          message: error instanceof Error ? `Codex 连接状态不可用：${error.message}` : "Codex 连接状态不可用"
        }
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const session = await api.getSession();
        if (cancelled) {
          return;
        }
        if (!session.authenticated) {
          setLoadState("login");
          return;
        }
        await refreshDashboard();
        await refreshCodexSources();
        if (!cancelled) {
          setLoadState("ready");
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          setLoadState("login");
          return;
        }
        setLoadState("ready");
        dispatch({
          type: "setNotice",
          notice: {
            kind: "warning",
            message: error instanceof Error ? `使用本地初始草稿：${error.message}` : "使用本地初始草稿"
          }
        });
      }
    }

    void boot();

    return () => {
      cancelled = true;
    };
  }, [refreshCodexSources, refreshDashboard]);

  const mutateDashboard = useCallback((dashboard: DashboardDraft, selectedId?: string | null, notice?: Notice) => {
    dispatch({ type: "mutate", dashboard, selectedId, notice });
  }, []);

  const pollJob = useCallback(async (job: JobResponse, kind: "preview" | "publish") => {
    let current = job;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (["succeeded", "failed", "superseded"].includes(current.status)) {
        dispatch(kind === "preview" ? { type: "previewDone", job: current } : { type: "publishDone", job: current });
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 750));
      try {
        current = await api.getJob(job.id);
      } catch (error) {
        dispatch({
          type: "jobFailed",
          kind,
          message: error instanceof Error ? error.message : "任务状态读取失败"
        });
        return;
      }
      dispatch(kind === "preview" ? { type: "previewDone", job: current } : { type: "publishDone", job: current });
    }
  }, []);

  const handleLogin = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setLoginError(null);
      try {
        await api.login(password);
        await refreshDashboard();
        await refreshCodexSources();
        setLoadState("ready");
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : "登录失败");
      }
    },
    [password, refreshCodexSources, refreshDashboard]
  );

  const addWidgetAt = useCallback(
    (definition: PublicWidgetDefinition, requestedPosition?: Pick<WidgetInstance, "column" | "row">) => {
      const id = makeId(definition.manifest.type as WidgetType);
      const size = definition.manifest.defaultSize;
      const baseWidget: WidgetInstance = {
        id,
        type: definition.manifest.type,
        configVersion: definition.manifest.configVersion,
        column: 0,
        row: 0,
        columnSpan: size.columns,
        rowSpan: size.rows,
        config: cloneConfig(definition.defaults)
      };
      const position = findFirstAvailablePlacement(
        state.dashboard.grid, state.dashboard.widgets, size
      );
      const requestedPlacement = requestedPosition
        ? { ...requestedPosition, columnSpan: size.columns, rowSpan: size.rows }
        : null;
      const resolvedPosition = requestedPlacement ?? position;
      const positionedWidget = resolvedPosition ? { ...baseWidget, ...resolvedPosition } : null;
      if (!positionedWidget || (requestedPlacement && !canPlace(state.dashboard.widgets, positionedWidget, state.dashboard))) {
        dispatch({
          type: "setNotice",
          notice: {
            kind: "warning",
            message: requestedPlacement
              ? `当前位置无法放置 ${definition.manifest.displayName}`
              : `没有可容纳 ${definition.manifest.displayName} 的空位`
          }
        });
        return;
      }
      mutateDashboard(
        {
          ...state.dashboard,
          widgets: [...state.dashboard.widgets, positionedWidget]
        },
        id,
        { kind: "success", message: `已添加 ${definition.manifest.displayName}` }
      );
      setInspectorTab("properties");
      setCanvasMode("layout");
    },
    [mutateDashboard, state.dashboard]
  );

  const addWidget = useCallback((definition: PublicWidgetDefinition) => addWidgetAt(definition), [addWidgetAt]);

  const duplicateWidget = useCallback(() => {
    if (!selectedWidget || !selectedDefinition) {
      return;
    }
    const id = makeId(selectedWidget.type as WidgetType);
    const size = { columns: selectedWidget.columnSpan, rows: selectedWidget.rowSpan };
    const clone: WidgetInstance = {
      ...selectedWidget,
      id,
      config: cloneConfig(selectedWidget.config)
    };
    const position = findFirstAvailablePlacement(
      state.dashboard.grid,
      state.dashboard.widgets,
      size
    );
    if (!position) {
      dispatch({
        type: "setNotice",
        notice: { kind: "warning", message: `没有可复制 ${selectedDefinition.manifest.displayName} 的空位` }
      });
      return;
    }
    mutateDashboard(
      {
        ...state.dashboard,
        widgets: [...state.dashboard.widgets, { ...clone, ...position }]
      },
      id,
      { kind: "success", message: "已复制组件，配置保持独立" }
    );
  }, [mutateDashboard, selectedDefinition, selectedWidget, state.dashboard]);

  const deleteWidget = useCallback(() => {
    if (!selectedWidget) {
      return;
    }
    const widgets = state.dashboard.widgets.filter((widget) => widget.id !== selectedWidget.id);
    mutateDashboard({ ...state.dashboard, widgets }, widgets[0]?.id ?? null, {
      kind: "success",
      message: "已删除组件，可撤销"
    });
  }, [mutateDashboard, selectedWidget, state.dashboard]);

  const moveSelected = useCallback(
    (column: number, row: number) => {
      if (!selectedWidget) {
        return;
      }
      const next = moveIfValid(state.dashboard, selectedWidget.id, column, row);
      if (!next) {
        dispatch({ type: "setNotice", notice: { kind: "warning", message: "该位置不可用，布局已回退" } });
        return;
      }
      mutateDashboard(next);
    },
    [mutateDashboard, selectedWidget, state.dashboard]
  );

  const resizeSelected = useCallback(
    (size: WidgetSize) => {
      if (!selectedWidget) {
        return;
      }
      const next = resizeIfValid(state.dashboard, selectedWidget.id, size);
      if (!next) {
        dispatch({ type: "setNotice", notice: { kind: "warning", message: "该尺寸会越界或重叠，已回退" } });
        return;
      }
      mutateDashboard(next, selectedWidget.id);
    },
    [mutateDashboard, selectedWidget, state.dashboard]
  );

  const updateSelectedConfig = useCallback(
    (config: WidgetInstance["config"]) => {
      if (!selectedWidget) {
        return;
      }
      mutateDashboard(updateWidget(state.dashboard, selectedWidget.id, (widget) => ({ ...widget, config })));
    },
    [mutateDashboard, selectedWidget, state.dashboard]
  );

  const updateDashboardSettings = useCallback(
    (dashboard: DashboardDraft) => {
      const next = replaceDashboardIfValid(dashboard);
      if (!next) {
        dispatch({
          type: "setNotice",
          notice: { kind: "warning", message: "画布设置会造成非法布局，已回退" }
        });
        return;
      }
      mutateDashboard(next, null);
    },
    [mutateDashboard]
  );

  const saveDraft = useCallback(async () => {
    const issues = validateLayout(state.dashboard);
    if (issues.length > 0) {
      dispatch({
        type: "setNotice",
        notice: { kind: "error", message: "草稿包含非法布局，已阻止保存" }
      });
      return;
    }
    dispatch({ type: "saving" });
    try {
      const editorRevision = state.editorRevision;
      const response = await api.saveDraft(state.dashboard, state.savedRevision);
      dispatch({ type: "saved", payload: response, editorRevision });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        dispatch({ type: "conflict", message: "草稿修订冲突，请刷新后合并本地修改" });
        return;
      }
      dispatch({
        type: "setNotice",
        notice: { kind: "error", message: error instanceof Error ? error.message : "保存草稿失败" }
      });
    }
  }, [state.dashboard, state.savedRevision]);

  const createPreview = useCallback(async () => {
    const issues = validateLayout(state.dashboard);
    if (issues.length > 0) {
      dispatch({
        type: "setNotice",
        notice: { kind: "error", message: "非法布局不能预览" }
      });
      return;
    }
    try {
      const editorRevision = state.editorRevision;
      const job = await api.createPreview(state.dashboard, editorRevision);
      dispatch({ type: "previewQueued", editorRevision, job });
      void pollJob(job, "preview");
    } catch (error) {
      dispatch({
        type: "setNotice",
        notice: { kind: "error", message: error instanceof Error ? error.message : "预览任务提交失败" }
      });
    }
  }, [pollJob, state.dashboard, state.editorRevision]);

  const publish = useCallback(async () => {
    if (!canPublish) {
      dispatch({ type: "setNotice", notice: { kind: "warning", message: "发布前请先保存当前草稿" } });
      return;
    }
    try {
      const job = await api.publish(state.savedRevision);
      dispatch({ type: "publishQueued", job });
      void pollJob(job, "publish");
    } catch (error) {
      dispatch({
        type: "setNotice",
        notice: { kind: "error", message: error instanceof Error ? error.message : "发布任务提交失败" }
      });
    }
  }, [canPublish, pollJob, state.savedRevision]);

  const createDisplayToken = useCallback(async () => {
    try {
      const response = await api.createDisplayToken();
      dispatch({ type: "displayToken", url: new URL(response.url, window.location.origin).href });
    } catch (error) {
      dispatch({
        type: "setNotice",
        notice: { kind: "error", message: error instanceof Error ? error.message : "创建图片地址失败" }
      });
    }
  }, []);

  const createConnection = useCallback(async () => {
    try {
      const connection = await api.createCodexConnection(connectionDraftName.trim() || "本机 Codex");
      const response = await api.listCodexConnections();
      setCodexSources(response);
      if (selectedWidget?.type === "codex-usage") {
        const codexConfig = selectedWidget.config as CodexUsageConfig;
        mutateDashboard(
          updateWidget(state.dashboard, selectedWidget.id, (widget) => ({
            ...widget,
            config: toJsonObject({
              ...codexConfig,
              connectionId: connection.id,
              connectionRevision: connection.revision
            })
          })),
          selectedWidget.id
        );
      }
      dispatch({ type: "setNotice", notice: { kind: "success", message: "已创建本机 Codex 连接" } });
    } catch (error) {
      dispatch({
        type: "setNotice",
        notice: { kind: "error", message: error instanceof Error ? error.message : "创建连接失败" }
      });
    }
  }, [connectionDraftName, mutateDashboard, selectedWidget, state.dashboard]);

  const testConnection = useCallback(
    async (connectionId?: string, connectionRevision?: number) => {
      const seq = connectionTestSeq.current + 1;
      connectionTestSeq.current = seq;
      try {
        const response = await api.testCodexConnection(connectionId, connectionRevision);
        if (seq !== connectionTestSeq.current) {
          return;
        }
        setConnectionTest(response);
        setCodexSources((current) => ({ ...current, groups: response.groups, lastRead: response }));
        dispatch({
          type: "setNotice",
          notice: {
            kind: response.status === "ok" ? "success" : "warning",
            message: response.error ?? `Codex 连接测试：${renderCodexStatus(response.status)}`
          }
        });
      } catch (error) {
        if (seq !== connectionTestSeq.current) {
          return;
        }
        dispatch({
          type: "setNotice",
          notice: { kind: "error", message: error instanceof Error ? error.message : "连接测试失败" }
        });
      }
    },
    []
  );

  const refreshConnection = useCallback(async (connectionId: string) => {
    const seq = connectionTestSeq.current + 1;
    connectionTestSeq.current = seq;
    try {
      const response = await api.refreshCodexConnection(connectionId);
      if (seq !== connectionTestSeq.current) {
        return;
      }
      setConnectionTest(response);
      setCodexSources((current) => ({ ...current, groups: response.groups, lastRead: response }));
      dispatch({
        type: "setNotice",
        notice: { kind: response.status === "ok" ? "success" : "warning", message: `Codex 额度读取：${renderCodexStatus(response.status)}` }
      });
    } catch (error) {
      if (seq !== connectionTestSeq.current) {
        return;
      }
      dispatch({
        type: "setNotice",
        notice: { kind: "error", message: error instanceof Error ? error.message : "刷新连接失败" }
      });
    }
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (canvasMode !== "layout") return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch({ type: "undo" });
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        duplicateWidget();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteWidget();
        return;
      }
      if (!selectedWidget) {
        return;
      }
      const movement: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1]
      };
      const delta = movement[event.key];
      if (!delta) {
        return;
      }
      event.preventDefault();
      moveSelected(selectedWidget.column + delta[0], selectedWidget.row + delta[1]);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canvasMode, deleteWidget, duplicateWidget, moveSelected, selectedWidget]);

  const pointerToScreen = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * state.dashboard.screen.width,
      y: ((clientY - rect.top) / rect.height) * state.dashboard.screen.height
    };
  }, [state.dashboard.screen.height, state.dashboard.screen.width]);

  const startDrag = useCallback(
    (event: React.PointerEvent, widget: WidgetInstance) => {
      event.preventDefault();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      const pointer = pointerToScreen(event.clientX, event.clientY);
      const rect = computePixelRect(state.dashboard.screen, state.dashboard.grid, widget);
      setDrag({
        widgetId: widget.id,
        pointerId: event.pointerId,
        startColumn: widget.column,
        startRow: widget.row,
        grabOffsetX: pointer ? pointer.x - rect.x : 0,
        grabOffsetY: pointer ? pointer.y - rect.y : 0,
        column: widget.column,
        row: widget.row,
        valid: true
      });
      dispatch({ type: "select", widgetId: widget.id });
    },
    [pointerToScreen, state.dashboard.grid, state.dashboard.screen]
  );

  const moveDrag = useCallback(
    (event: React.PointerEvent, widget: WidgetInstance) => {
      if (!drag || drag.widgetId !== widget.id || drag.pointerId !== event.pointerId) {
        return;
      }
      const pointer = pointerToScreen(event.clientX, event.clientY);
      if (!pointer) {
        return;
      }
      const next = snapPointerToGrid(
        state.dashboard.screen,
        state.dashboard.grid,
        { x: pointer.x - drag.grabOffsetX, y: pointer.y - drag.grabOffsetY },
        { columns: widget.columnSpan, rows: widget.rowSpan }
      );
      const candidate = { ...widget, column: next.column, row: next.row };
      setDrag({
        ...drag,
        ...next,
        valid: canPlace(state.dashboard.widgets, candidate, state.dashboard, widget.id)
      });
    },
    [drag, pointerToScreen, state.dashboard]
  );

  const endDrag = useCallback(
    (event: React.PointerEvent, widget: WidgetInstance) => {
      if (!drag || drag.widgetId !== widget.id || drag.pointerId !== event.pointerId) {
        return;
      }
      const target = event.currentTarget as HTMLElement;
      if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
      const nextDashboard = drag.valid ? moveIfValid(state.dashboard, widget.id, drag.column, drag.row) : null;
      setDrag(null);
      if (!nextDashboard) {
        dispatch({ type: "setNotice", notice: { kind: "warning", message: "位置无效，组件已回到原处" } });
        return;
      }
      if (widget.column !== drag.column || widget.row !== drag.row) {
        mutateDashboard(nextDashboard, widget.id);
      }
    },
    [drag, mutateDashboard, state.dashboard]
  );

  const cancelDrag = useCallback(
    (event: React.PointerEvent, widget: WidgetInstance) => {
      if (!drag || drag.widgetId !== widget.id || drag.pointerId !== event.pointerId) {
        return;
      }
      const target = event.currentTarget as HTMLElement;
      if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
      setDrag(null);
      dispatch({ type: "setNotice", notice: { kind: "warning", message: "拖动已取消，组件已回到原处" } });
    },
    [drag]
  );

  const getLibraryDefinitionFromTransfer = useCallback((dataTransfer: DataTransfer) => {
    const type = dataTransfer.getData(LIBRARY_DRAG_MIME) || dataTransfer.getData("text/plain");
    return (type ? getWidgetDefinition(type) : undefined) ?? libraryDragRef.current;
  }, []);

  const handleLibraryDragStart = useCallback((event: React.DragEvent, definition: PublicWidgetDefinition) => {
    libraryDragRef.current = definition;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(LIBRARY_DRAG_MIME, definition.manifest.type);
    event.dataTransfer.setData("text/plain", definition.manifest.type);
    setLibraryDrop(null);
  }, []);

  const handleLibraryDragEnd = useCallback(() => {
    libraryDragRef.current = null;
    setLibraryDrop(null);
  }, []);

  const handleLibraryDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const definition = getLibraryDefinitionFromTransfer(event.dataTransfer);
      if (!definition || canvasMode !== "layout") {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      const pointer = pointerToScreen(event.clientX, event.clientY);
      if (!pointer) {
        return;
      }
      const size = definition.manifest.defaultSize;
      const next = snapPointerToGrid(state.dashboard.screen, state.dashboard.grid, pointer, size);
      const candidate: WidgetInstance = {
        id: "library-drop-preview",
        type: definition.manifest.type,
        configVersion: definition.manifest.configVersion,
        ...next,
        columnSpan: size.columns,
        rowSpan: size.rows,
        config: cloneConfig(definition.defaults)
      };
      setLibraryDrop({
        type: definition.manifest.type,
        displayName: definition.manifest.displayName,
        column: next.column,
        row: next.row,
        columnSpan: size.columns,
        rowSpan: size.rows,
        valid: canPlace(state.dashboard.widgets, candidate, state.dashboard)
      });
    },
    [canvasMode, getLibraryDefinitionFromTransfer, pointerToScreen, state.dashboard]
  );

  const handleLibraryDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget as Node | null;
    if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) {
      setLibraryDrop(null);
    }
  }, []);

  const handleLibraryDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const definition = getLibraryDefinitionFromTransfer(event.dataTransfer);
      if (!definition) {
        return;
      }
      event.preventDefault();
      const pointer = pointerToScreen(event.clientX, event.clientY);
      if (pointer) {
        const size = definition.manifest.defaultSize;
        const position = snapPointerToGrid(state.dashboard.screen, state.dashboard.grid, pointer, size);
        addWidgetAt(definition, position);
      }
      libraryDragRef.current = null;
      setLibraryDrop(null);
    },
    [addWidgetAt, getLibraryDefinitionFromTransfer, pointerToScreen, state.dashboard]
  );

  if (loadState === "checking") {
    return <div className="centered">正在读取会话与草稿…</div>;
  }

  if (loadState === "login") {
    return (
      <main className="login-screen">
        <form className="login-card" onSubmit={handleLogin}>
          <div className="brand-mark"><StudioIcon name="tablet_android" /></div>
          <h1>InkStack 墨栈</h1>
          <label>
            管理员密码
            <input
              autoFocus
              type="password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </label>
          {loginError ? <p className="form-error">{loginError}</p> : null}
          <button className="primary-button" type="submit">登录</button>
        </form>
      </main>
    );
  }

  const filteredCatalog = widgetCatalog.filter(({ manifest }) => {
    const matchesQuery = `${manifest.displayName} ${manifest.description} ${manifest.type}`.toLowerCase().includes(libraryQuery.trim().toLowerCase());
    const matchesCategory = libraryCategory === "all" || (libraryCategory === "data" ? manifest.category === "account" : manifest.category !== "account");
    return matchesQuery && matchesCategory && (librarySize === "all" || manifest.supportedSizes.some((size) => sizeLabel(size) === librarySize));
  });
  const catalogSizes = [...new Set(widgetCatalog.flatMap(({ manifest }) => manifest.supportedSizes.map(sizeLabel)))];
  const previewBusy = state.preview.status === "queued" || state.preview.status === "running";
  const previewCurrent = state.preview.status === "ready" && state.preview.editorRevision === state.editorRevision;
  const draftLabel = { clean: "草稿已保存", dirty: "有未保存修改", saving: "正在保存", conflict: "草稿版本冲突" }[state.draftStatus];
  const selectWidget = (widgetId: string) => {
    dispatch({ type: "select", widgetId });
    setInspectorTab("properties");
    setCanvasMode("layout");
  };
  const openPreview = () => {
    setCanvasMode("preview");
    if (!previewCurrent && !previewBusy) void createPreview();
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><StudioIcon name="tablet_android" /></div>
          <div><strong>InkStack 墨栈</strong><span>屏保组件工坊</span></div>
        </div>
        <button className="device-chip" type="button" onClick={() => setInspectorTab("canvas")}>
          <StudioIcon name="tablet_android" /><strong>Kindle 工作台</strong>
          <span>{state.dashboard.screen.width} × {state.dashboard.screen.height}</span>
        </button>
        <nav className="studio-nav" aria-label="工作台导航">
          <button type="button" className={inspectorTab !== "device" ? "active" : ""} onClick={() => { setInspectorTab("properties"); setCanvasMode("layout"); }}>设计工作台</button>
          <button type="button" className={inspectorTab === "device" ? "active" : ""} onClick={() => setInspectorTab("device")}>设备与发布</button>
        </nav>
        <div className="toolbar-actions">
          <button type="button" className="ghost-button icon-button" title="撤销" aria-label="撤销" disabled={!state.undoStack.length} onClick={() => dispatch({ type: "undo" })}><StudioIcon name="undo" /></button>
          <button type="button" className="ghost-button" onClick={saveDraft} disabled={state.draftStatus === "saving"}><StudioIcon name="save" />保存草稿</button>
          <button type="button" className="ghost-button" onClick={() => { setCanvasMode("preview"); void createPreview(); }} disabled={previewBusy}><StudioIcon name="visibility" />{previewBusy ? "生成中" : "预览"}</button>
          <button type="button" className="primary-button" onClick={publish} disabled={!canPublish} title={canPublish ? "发布已保存的草稿" : "请先保存草稿，等待当前发布完成"}><StudioIcon name="upload" />发布</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="left-panel" aria-label="组件库与图层">
          <section className="library-controls">
            <div className="panel-heading"><StudioIcon name="grid_view" /><h2>组件库</h2><span className="count-badge">{widgetCatalog.length} 款</span></div>
            <label className="search-field"><StudioIcon name="search" /><input type="search" aria-label="搜索组件" placeholder="搜索组件…" value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} /></label>
            <div className="filter-label"><span>规格筛选</span><small>{state.dashboard.grid.columns} × {state.dashboard.grid.rows} 网格</small></div>
            <div className="size-filter" aria-label="规格筛选">
              {["all", ...catalogSizes].map((size) => <button type="button" key={size} aria-pressed={librarySize === size} className={librarySize === size ? "active" : ""} onClick={() => setLibrarySize(size)}>{size === "all" ? "全部" : size.replace(" x ", "×")}</button>)}
            </div>
            <div className="filter-label">分类导航</div>
            <div className="category-filter">{[["all", "全部"], ["local", "本地组件"], ["data", "数据监控"]].map(([key, label]) => <button key={key} type="button" aria-pressed={libraryCategory === key} className={libraryCategory === key ? "active" : ""} onClick={() => setLibraryCategory(key)}>{label}</button>)}</div>
          </section>
          <div className="library-list">
            {filteredCatalog.map((definition) => <LibraryButton key={definition.manifest.type} definition={definition} onAdd={() => addWidget(definition)} onDragStart={handleLibraryDragStart} onDragEnd={handleLibraryDragEnd} />)}
            {!filteredCatalog.length && <div className="empty-state"><StudioIcon name="search" /><p>没有符合条件的组件</p><button type="button" className="ghost-button" onClick={() => { setLibraryQuery(""); setLibraryCategory("all"); setLibrarySize("all"); }}>清除筛选</button></div>}
          </div>
          <section className="layers-panel">
            <div className="panel-heading"><StudioIcon name="layers" /><h2>画布图层</h2><span className="count-badge">{state.dashboard.widgets.length}</span></div>
            {state.dashboard.widgets.map((widget, index) => <button type="button" className={`layer-row ${widget.id === state.selectedId ? "active" : ""}`} key={widget.id} aria-pressed={widget.id === state.selectedId} onClick={() => selectWidget(widget.id)}><StudioIcon name={widgetIcon(widget.type)} /><strong>{getWidgetDefinition(widget.type)?.manifest.displayName ?? widget.type} {index + 1}</strong><small>{widget.columnSpan}×{widget.rowSpan}</small></button>)}
            {!state.dashboard.widgets.length && <p className="muted-copy">从组件库添加第一个组件。</p>}
          </section>
          <div className="hint-card"><StudioIcon name="info" /><p>拖拽组件到画布，或点击添加。<br />画布内可继续拖动排版；方向键微调位置，删除后可撤销。</p></div>
        </aside>

        <section className="canvas-column" aria-label="设计画布">
          <div className="canvas-header">
            <div><h1>{state.dashboard.name}</h1><p><StatusDot status={layoutIssues.length ? "conflict" : "clean"} />{layoutIssues.length ? `${layoutIssues.length} 个布局问题` : "网格吸附已开启"} · {state.dashboard.grid.columns} × {state.dashboard.grid.rows}</p></div>
            <div className="segmented-control" aria-label="画布显示模式">
              <button type="button" className={canvasMode === "layout" ? "active" : ""} aria-pressed={canvasMode === "layout"} onClick={() => setCanvasMode("layout")}>编辑</button>
              <button type="button" className={canvasMode === "preview" ? "active" : ""} aria-pressed={canvasMode === "preview"} onClick={openPreview}>PNG 预览</button>
            </div>
          </div>
          <div className="canvas-stage">
            <div className="device-frame" style={{ width: zoom === "100" ? "max-content" : `min(100%, max(260px, min(600px, calc((100dvh - 350px) * ${state.dashboard.screen.width / state.dashboard.screen.height} + 44px))))`, flexShrink: 0 }}>
              <div className="device-screen-wrap" style={zoom === "100" ? { width: state.dashboard.screen.width } : undefined}>
                {canvasMode === "layout" ? <WidgetCanvas
                  dashboard={state.dashboard} selectedId={state.selectedId} layoutIssues={layoutIssues} drag={drag} libraryDrop={libraryDrop} canvasRef={canvasRef} showGrid={showGrid} previewImageUrl={previewCurrent ? state.preview.url : null}
                  onSelect={selectWidget}
                  onPointerDown={(event, widget) => { setInspectorTab("properties"); startDrag(event, widget); }}
                  onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag}
                  onDragOver={handleLibraryDragOver} onDragLeave={handleLibraryDragLeave} onDrop={handleLibraryDrop}
                /> : state.preview.url ? <img className="device-preview" src={state.preview.url} alt="服务端生成的最终 PNG 预览" /> : <div className="device-empty" style={{ aspectRatio: `${state.dashboard.screen.width} / ${state.dashboard.screen.height}` }}><StudioIcon name="visibility" /><strong>{previewBusy ? "正在生成墨水屏画面" : "尚无可用预览"}</strong><p>{state.preview.message}</p>{!previewBusy && <button type="button" className="ghost-button" onClick={createPreview}>重新生成</button>}</div>}
              </div>
              <div className="device-wordmark">kindle</div>
            </div>
          </div>
          <div className="canvas-caption">{canvasMode === "layout" ? (previewCurrent ? "与 PNG 预览一致 · 可直接选择和拖动组件" : "实时排版 · 生成 PNG 后同步数据与最终画面") : `${previewCurrent ? "当前画面" : "预览待更新"} · ${state.preview.message}`}</div>
          <div className="canvas-bottom-tools">
            <button type="button" className={`ghost-button ${showGrid ? "selected-choice" : ""}`} aria-pressed={showGrid} onClick={() => setShowGrid(!showGrid)} disabled={canvasMode !== "layout"}><StudioIcon name="grid_view" />网格</button>
            <div className="segmented-control" aria-label="画布缩放"><button type="button" aria-pressed={zoom === "fit"} className={zoom === "fit" ? "active" : ""} onClick={() => setZoom("fit")}>适应窗口</button><button type="button" aria-pressed={zoom === "100"} className={zoom === "100" ? "active" : ""} onClick={() => setZoom("100")}>100%</button></div>
            {state.preview.url && <a className="ghost-button" href={state.preview.url} download="inkstack-preview.png"><StudioIcon name="download" />下载{previewCurrent ? " PNG" : "旧预览"}</a>}
          </div>
        </section>

        <aside className="right-panel" aria-label="属性与设备设置">
          <div className="inspector-tabs">{([["properties", "组件属性"], ["canvas", "画布"], ["device", "设备"]] as const).map(([key, label]) => <button type="button" key={key} className={inspectorTab === key ? "active" : ""} aria-pressed={inspectorTab === key} onClick={() => setInspectorTab(key)}>{label}</button>)}</div>
          {inspectorTab === "device" ? <>
            <PanelHeader title="设备与发布" subtitle="让墨水屏显示你的最新画面" />
            <section className="publish-pane">
              <div className="connection-status"><strong>{state.publishedRevision === null ? "尚未发布画面" : `已发布 · 修订 ${state.publishedRevision}`}</strong><span>{state.publish.message}</span></div>
              <dl><div><dt>草稿</dt><dd>{draftLabel} · 修订 {state.savedRevision}</dd></div><div><dt>屏幕尺寸</dt><dd>{state.dashboard.screen.width} × {state.dashboard.screen.height}</dd></div><div><dt>最近取图</dt><dd>{formatDateTime(state.lastDisplayRequestAt)}</dd></div></dl>
              <h3 className="section-title">设备图片地址</h3>
              <p className="muted-copy">将图片地址配置到 Kindle 屏保客户端，设备会按自己的日程获取已发布画面。</p>
              {state.displayUrl ? <label>图片地址<input readOnly value={new URL(state.displayUrl, window.location.origin).href} onFocus={(event) => event.currentTarget.select()} /></label> : <p className="muted-copy">{state.displayTokenConfigured ? "地址已配置。原地址只在创建时显示，请使用已保存的地址。" : "先创建一个设备图片地址。"}</p>}
              <button type="button" className="ghost-button" onClick={createDisplayToken}>{state.displayUrl || state.displayTokenConfigured ? "轮换图片地址" : "创建图片地址"}</button>
              {(state.displayUrl || state.displayTokenConfigured) && <p className="muted-copy">轮换会使旧地址失效，需要更新设备配置。</p>}
              {state.snapshotUrl && <a className="ghost-button" href={state.snapshotUrl} download="inkstack-published.png"><StudioIcon name="download" />下载已发布 PNG</a>}
              {state.lastServerError && <p className="form-error">{state.lastServerError}</p>}
            </section>
          </> : inspectorTab === "canvas" || !selectedWidget || !selectedDefinition ? <>
            <PanelHeader title="画布设置" subtitle="屏幕尺寸与网格布局" />
            <CanvasInspector dashboard={state.dashboard} onChange={updateDashboardSettings} />
          </> : <>
            <PanelHeader title="相关属性" subtitle={`${selectedDefinition.manifest.displayName} · ${selectedWidget.columnSpan} × ${selectedWidget.rowSpan}`} />
            <WidgetInspector widget={selectedWidget} definition={selectedDefinition} issue={selectedIssue?.message ?? null} onMove={moveSelected} onResize={resizeSelected} onDelete={deleteWidget} onDuplicate={duplicateWidget} />
            <ConfigInspector widget={selectedWidget} config={selectedWidget.config} onChange={updateSelectedConfig} codexSources={codexSources} connectionName={connectionDraftName} onConnectionNameChange={setConnectionDraftName} onCreateConnection={createConnection} onRefreshConnections={refreshCodexSources} onTestConnection={testConnection} onRefreshConnection={refreshConnection} connectionTest={connectionTest} />
          </>}
        </aside>
      </section>
      <footer className="bottom-status">
        <div className="status-summary"><StatusDot status={state.draftStatus} /><span>{draftLabel}</span><span>修订 {state.savedRevision}</span></div>
        <span role="status" aria-live="polite" className={`notice ${state.notice?.kind ?? ""}`}>{state.notice?.message ?? "选择组件，开始设计你的屏保"}</span>
        <span>{state.dashboard.screen.width} × {state.dashboard.screen.height} · 灰度 PNG</span>
      </footer>
    </main>
  );
}

function StatusDot({ status }: { status: DraftStatus }) {
  return <span className={`status-dot ${status}`} aria-label={`草稿状态 ${status}`} />;
}

function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      <p>{subtitle}</p>
    </div>
  );
}

function LibraryButton({
  definition,
  onAdd,
  onDragStart,
  onDragEnd
}: {
  definition: PublicWidgetDefinition;
  onAdd: () => void;
  onDragStart: (event: React.DragEvent, definition: PublicWidgetDefinition) => void;
  onDragEnd: () => void;
}) {
  const { manifest } = definition;
  const suppressClick = useRef(false);
  const sourceLabel = manifest.type === "calendar"
    ? "Google 日历 · OAuth"
    : manifest.type === "weather"
      ? "和风天气 · 服务端连接"
      : manifest.type === "image"
        ? "相册目录 · 服务端资源"
        : manifest.category === "account" ? "数据连接 · Codex" : "本地组件 · 无需连接";
  return (
    <button
      type="button"
      className="library-button"
      draggable
      onClick={() => {
        if (suppressClick.current) {
          return;
        }
        onAdd();
      }}
      onDragStart={(event) => {
        suppressClick.current = true;
        onDragStart(event, definition);
      }}
      onDragEnd={() => {
        onDragEnd();
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }}
      aria-label={`添加${manifest.displayName}`}
      title="拖拽到画布，或点击添加"
    >
      <span className="library-card-heading"><StudioIcon name={widgetIcon(manifest.type)} /><strong>{manifest.displayName}</strong><small>{manifest.defaultSize.columns}×{manifest.defaultSize.rows}</small></span>
      <span className="library-description">{manifest.description}</span>
      <span className="library-card-footer"><span>{sourceLabel}</span><StudioIcon name="add" /></span>
    </button>
  );
}

function WidgetInspector({
  widget,
  definition,
  issue,
  onMove,
  onResize,
  onDelete,
  onDuplicate
}: {
  widget: WidgetInstance;
  definition: PublicWidgetDefinition;
  issue: string | null;
  onMove: (column: number, row: number) => void;
  onResize: (size: WidgetSize) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  return (
    <section className="inspector-section">
      <div className="selected-summary">
        <span className="library-icon compact"><StudioIcon name={widgetIcon(definition.manifest.type)} /></span>
        <div>
          <strong>{definition.manifest.displayName}</strong>
          <small>{definition.manifest.description}</small>
        </div>
      </div>
      {issue ? <p className="form-error">{issue}</p> : null}
      <div className="field-grid two">
        <label>
          列
          <input type="number" min={0} value={widget.column} onChange={(event) => onMove(ensureNumber(event.currentTarget.value, widget.column), widget.row)} />
        </label>
        <label>
          行
          <input type="number" min={0} value={widget.row} onChange={(event) => onMove(widget.column, ensureNumber(event.currentTarget.value, widget.row))} />
        </label>
      </div>
      <div className="size-list">
        {definition.manifest.supportedSizes.map((size) => (
          <button
            key={sizeLabel(size)}
            type="button"
            className={size.columns === widget.columnSpan && size.rows === widget.rowSpan ? "selected-choice" : "ghost-button"}
            onClick={() => onResize(size)}
          >
            {sizeLabel(size)}
          </button>
        ))}
      </div>
      <div className="split-actions">
        <button type="button" className="ghost-button" onClick={onDuplicate}>复制</button>
        <button type="button" className="danger-button" onClick={onDelete}>删除</button>
      </div>
    </section>
  );
}

function ConfigInspector({
  widget,
  config,
  onChange,
  codexSources,
  connectionName,
  onConnectionNameChange,
  onCreateConnection,
  onRefreshConnections,
  onTestConnection,
  onRefreshConnection,
  connectionTest
}: {
  widget: WidgetInstance;
  config: WidgetInstance["config"];
  onChange: (config: WidgetInstance["config"]) => void;
  codexSources: CodexConnectionResponse;
  connectionName: string;
  onConnectionNameChange: (name: string) => void;
  onCreateConnection: () => void;
  onRefreshConnections: () => void;
  onTestConnection: (connectionId?: string, connectionRevision?: number) => void;
  onRefreshConnection: (connectionId: string) => void;
  connectionTest: CodexConnectionTestResponse | null;
}) {
  if (widget.type === "text") {
    const text = config as TextConfig;
    return (
      <section className="inspector-section">
        <SectionTitle title="显示" />
        <TextInput label="标题" value={text.title} onChange={(title) => onChange({ ...text, title })} />
        <label>
          正文
          <textarea value={text.text} onChange={(event) => onChange(toJsonObject({ ...text, text: event.currentTarget.value }))} />
        </label>
        <SelectInput label="字号" value={text.size} options={[["small", "小"], ["medium", "中"], ["large", "大"]]} onChange={(size) => onChange(toJsonObject({ ...text, size: size as TextConfig["size"] }))} />
        <SelectInput label="对齐" value={text.align} options={[["left", "左"], ["center", "中"], ["right", "右"]]} onChange={(align) => onChange(toJsonObject({ ...text, align: align as TextConfig["align"] }))} />
        <CheckboxInput label="显示边框" checked={text.showBorder} onChange={(showBorder) => onChange(toJsonObject({ ...text, showBorder }))} />
        <CheckboxInput label="显示背景" checked={text.showBackground} onChange={(showBackground) => onChange(toJsonObject({ ...text, showBackground }))} />
      </section>
    );
  }

  if (widget.type === "date") {
    const date = config as DateConfig;
    return (
      <section className="inspector-section">
        <SectionTitle title="显示" />
        <TextInput label="副标题" value={date.subtitle} onChange={(subtitle) => onChange(toJsonObject({ ...date, subtitle }))} />
        <SelectInput label="格式" value={date.format} options={[["short", "短日期"], ["full", "完整日期"], ["numeric", "数字"]]} onChange={(format) => onChange(toJsonObject({ ...date, format: format as DateConfig["format"] }))} />
        <CheckboxInput label="显示星期" checked={date.showWeekday} onChange={(showWeekday) => onChange(toJsonObject({ ...date, showWeekday }))} />
      </section>
    );
  }

  if (widget.type === "todo") {
    const todo = config as TodoConfig;
    return (
      <section className="inspector-section">
        <SectionTitle title="显示" />
        <TextInput label="标题" value={todo.title} onChange={(title) => onChange(toJsonObject({ ...todo, title }))} />
        <label>
          最大显示
          <input type="number" min={1} max={20} value={todo.maxVisible} onChange={(event) => onChange(toJsonObject({ ...todo, maxVisible: ensureNumber(event.currentTarget.value, todo.maxVisible) }))} />
        </label>
        <SelectInput label="排序" value={todo.sort} options={[["manual", "手动"], ["open-first", "未完成优先"]]} onChange={(sort) => onChange(toJsonObject({ ...todo, sort: sort as TodoConfig["sort"] }))} />
        <div className="todo-editor">
          {todo.items.map((item, index) => (
            <div className="todo-row" key={item.id}>
              <input type="checkbox" aria-label={`完成待办 ${index + 1}`} checked={item.done} onChange={(event) => {
              const items = todo.items.map((current) => current.id === item.id ? { ...current, done: event.currentTarget.checked } : current);
                onChange(toJsonObject({ ...todo, items }));
              }} />
              <input aria-label={`待办内容 ${index + 1}`} value={item.text} onChange={(event) => {
                const items = todo.items.map((current) => current.id === item.id ? { ...current, text: event.currentTarget.value } : current);
                onChange(toJsonObject({ ...todo, items }));
              }} />
              <button type="button" className="ghost-button icon-button" aria-label={`删除待办 ${index + 1}`} onClick={() => {
                const items = todo.items.filter((_, itemIndex) => itemIndex !== index);
                onChange(toJsonObject({ ...todo, items }));
              }}><StudioIcon name="close" /></button>
            </div>
          ))}
        </div>
        <button type="button" className="ghost-button" onClick={() => onChange(toJsonObject({ ...todo, items: [...todo.items, { id: makeId("todo"), text: "新待办", done: false }] }))}>添加待办</button>
      </section>
    );
  }

  if (widget.type === "calendar") {
    const calendar = config as CalendarConfig;
    return (
      <section className="inspector-section">
        <SectionTitle title="显示" />
        <TextInput label="标题" value={calendar.title} onChange={(title) => onChange(toJsonObject({ ...calendar, title }))} />
        <SelectInput label="布局" value={calendar.layout} options={[["month", "月历"], ["list", "日程列表"], ["month-list", "月历 + 日程"]]} onChange={(layout) => onChange(toJsonObject({ ...calendar, layout: layout as CalendarConfig["layout"] }))} />
        <TextInput label="指定月份（可选）" value={calendar.month} onChange={(month) => onChange(toJsonObject({ ...calendar, month }))} />
        <SelectInput label="每周起始" value={String(calendar.weekStartsOn)} options={[["1", "周一"], ["0", "周日"]]} onChange={(value) => onChange(toJsonObject({ ...calendar, weekStartsOn: Number(value) as CalendarConfig["weekStartsOn"] }))} />
        <CheckboxInput label="显示星期标题" checked={calendar.showWeekdays} onChange={(showWeekdays) => onChange(toJsonObject({ ...calendar, showWeekdays }))} />
        <label>
          Google 日历连接 ID
          <input value={calendar.connectionId} placeholder="完成 OAuth 后自动填充" onChange={(event) => onChange(toJsonObject({ ...calendar, connectionId: event.currentTarget.value }))} />
        </label>
        <label>
          日历 ID（逗号分隔）
          <input value={calendar.calendarIds.join(", ")} onChange={(event) => onChange(toJsonObject({ ...calendar, calendarIds: event.currentTarget.value.split(",").map((value) => value.trim()).filter(Boolean) }))} />
        </label>
        <p className="muted-copy">Google OAuth 授权和日历选择由服务端连接管理；保存后不会回传 refresh token。</p>
        <div className="field-grid two">
          <label>事件范围（天）<input type="number" min={1} max={31} value={calendar.eventRangeDays} onChange={(event) => onChange(toJsonObject({ ...calendar, eventRangeDays: ensureNumber(event.currentTarget.value, calendar.eventRangeDays) }))} /></label>
          <label>最多显示<input type="number" min={1} max={20} value={calendar.maxVisible} onChange={(event) => onChange(toJsonObject({ ...calendar, maxVisible: ensureNumber(event.currentTarget.value, calendar.maxVisible) }))} /></label>
        </div>
      </section>
    );
  }

  if (widget.type === "weather") {
    const weather = config as WeatherConfig;
    return (
      <section className="inspector-section">
        <SectionTitle title="显示" />
        <TextInput label="标题" value={weather.title} onChange={(title) => onChange(toJsonObject({ ...weather, title }))} />
        <SelectInput label="位置方式" value={weather.locationMode} options={[["city", "城市或 Location ID"], ["coordinates", "经纬度"]]} onChange={(locationMode) => onChange(toJsonObject({ ...weather, locationMode: locationMode as WeatherConfig["locationMode"] }))} />
        {weather.locationMode === "city" ? <TextInput label="城市 / Location ID" value={weather.city} onChange={(city) => onChange(toJsonObject({ ...weather, city }))} /> : <div className="field-grid two"><label>纬度<input type="number" min={-90} max={90} step="any" value={weather.latitude} onChange={(event) => onChange(toJsonObject({ ...weather, latitude: ensureNumber(event.currentTarget.value, weather.latitude) }))} /></label><label>经度<input type="number" min={-180} max={180} step="any" value={weather.longitude} onChange={(event) => onChange(toJsonObject({ ...weather, longitude: ensureNumber(event.currentTarget.value, weather.longitude) }))} /></label></div>}
        <SelectInput label="单位" value={weather.units} options={[["m", "公制（°C）"], ["i", "英制（°F）"]]} onChange={(units) => onChange(toJsonObject({ ...weather, units: units as WeatherConfig["units"] }))} />
        <label>
          和风连接 ID
          <input value={weather.connectionId} placeholder="服务端连接 ID" onChange={(event) => onChange(toJsonObject({ ...weather, connectionId: event.currentTarget.value }))} />
        </label>
        <p className="muted-copy">API Host、API Key 或 JWT 只保存在服务端连接中；这里仅保存连接引用。</p>
        <SectionTitle title="显示项目" />
        <CheckboxInput label="温度" checked={weather.showTemperature} onChange={(showTemperature) => onChange(toJsonObject({ ...weather, showTemperature }))} />
        <CheckboxInput label="天气状况" checked={weather.showCondition} onChange={(showCondition) => onChange(toJsonObject({ ...weather, showCondition }))} />
        <CheckboxInput label="体感温度" checked={weather.showFeelsLike} onChange={(showFeelsLike) => onChange(toJsonObject({ ...weather, showFeelsLike }))} />
        <CheckboxInput label="湿度" checked={weather.showHumidity} onChange={(showHumidity) => onChange(toJsonObject({ ...weather, showHumidity }))} />
        <CheckboxInput label="风速" checked={weather.showWind} onChange={(showWind) => onChange(toJsonObject({ ...weather, showWind }))} />
        <CheckboxInput label="三日预报（4×2）" checked={weather.showForecast} onChange={(showForecast) => onChange(toJsonObject({ ...weather, showForecast }))} />
        <CheckboxInput label="显示更新时间" checked={weather.showUpdatedAt} onChange={(showUpdatedAt) => onChange(toJsonObject({ ...weather, showUpdatedAt }))} />
        <label>采集间隔（秒）<input type="number" min={300} max={86400} value={weather.refreshSeconds} onChange={(event) => onChange(toJsonObject({ ...weather, refreshSeconds: ensureNumber(event.currentTarget.value, weather.refreshSeconds) }))} /></label>
      </section>
    );
  }

  if (widget.type === "image") {
    const image = config as ImageConfig;
    return (
      <section className="inspector-section">
        <SectionTitle title="图片相册" />
        <TextInput label="标题" value={image.title} onChange={(title) => onChange(toJsonObject({ ...image, title }))} />
        <SelectInput label="资源类型" value={image.sourceType} options={[["album", "平台相册"], ["directory", "登记目录"]]} onChange={(sourceType) => onChange(toJsonObject({ ...image, sourceType: sourceType as ImageConfig["sourceType"] }))} />
        <label>相册 / 目录 ID<input value={image.sourceId} placeholder="由服务端资源管理生成" onChange={(event) => onChange(toJsonObject({ ...image, sourceId: event.currentTarget.value }))} /></label>
        <CheckboxInput label="扫描子目录" checked={image.recursive} onChange={(recursive) => onChange(toJsonObject({ ...image, recursive }))} />
        <SelectInput label="选图方式" value={image.selection} options={[["random", "随机"], ["sequential", "按顺序"], ["fixed", "固定图片"]]} onChange={(selection) => onChange(toJsonObject({ ...image, selection: selection as ImageConfig["selection"] }))} />
        {image.selection === "fixed" ? <TextInput label="固定图片 ID" value={image.fixedImageId} onChange={(fixedImageId) => onChange(toJsonObject({ ...image, fixedImageId }))} /> : null}
        <CheckboxInput label="随机一轮内不重复" checked={image.noRepeat} onChange={(noRepeat) => onChange(toJsonObject({ ...image, noRepeat }))} />
        <label>轮换间隔（秒）<input type="number" min={60} max={31536000} value={image.rotationSeconds} onChange={(event) => onChange(toJsonObject({ ...image, rotationSeconds: ensureNumber(event.currentTarget.value, image.rotationSeconds) }))} /></label>
        <SelectInput label="图片适配" value={image.fit} options={[["contain", "完整显示并留白"], ["cover", "填满并裁剪"]]} onChange={(fit) => onChange(toJsonObject({ ...image, fit: fit as ImageConfig["fit"] }))} />
        <CheckboxInput label="灰度处理" checked={image.grayscale} onChange={(grayscale) => onChange(toJsonObject({ ...image, grayscale }))} />
        <CheckboxInput label="显示图片名" checked={image.showCaption} onChange={(showCaption) => onChange(toJsonObject({ ...image, showCaption }))} />
        <CheckboxInput label="显示边框" checked={image.showBorder} onChange={(showBorder) => onChange(toJsonObject({ ...image, showBorder }))} />
        <p className="muted-copy">目录由服务端登记和扫描；浏览器不能读取服务器路径，远程图片 URL 也不会直接加载。</p>
      </section>
    );
  }

  const codex = config as CodexUsageConfig;
  const connectionOptions = codexSources.connections.some((connection) => connection.id === "local-codex-app-server")
    ? codexSources.connections
    : [
        {
          id: "local-codex-app-server",
          type: "codex-local" as const,
          revision: 1,
          name: "默认本机 Codex",
          settings: {},
          configured: true
        },
        ...codexSources.connections
      ];
  const quotaGroupOptions = codexSources.groups.some((group) => group.id === "codex")
    ? codexSources.groups
    : [{ id: "codex", name: "codex" }, ...codexSources.groups];
  const currentConnection = connectionOptions.find((connection) => connection.id === codex.connectionId);

  return (
    <section className="inspector-section">
      <SectionTitle title="显示" />
      <TextInput label="账号别名" value={codex.alias} onChange={(alias) => onChange(toJsonObject({ ...codex, alias }))} />
      <label>
        低余额阈值
        <input type="number" min={1} max={99} value={codex.lowBalanceThreshold} onChange={(event) => onChange(toJsonObject({ ...codex, lowBalanceThreshold: ensureNumber(event.currentTarget.value, codex.lowBalanceThreshold) }))} />
      </label>

      <SectionTitle title="数据连接" />
      <p className="muted-copy">首版只支持同机 Codex App Server，只读读取额度。不填写 OpenAI API key 或任意 URL。</p>
      <label>
        已有连接
        <select value={codex.connectionId} onChange={(event) => {
          const connection = connectionOptions.find((item) => item.id === event.currentTarget.value);
          onChange(toJsonObject({
            ...codex,
            connectionId: connection?.id ?? "local-codex-app-server",
            connectionRevision: connection?.revision ?? 1
          }));
        }}>
          {connectionOptions.map((connection) => (
            <option key={`${connection.id}-${connection.revision}`} value={connection.id}>
              {connection.name} · v{connection.revision}
            </option>
          ))}
        </select>
      </label>
      <div className="split-actions">
        <input aria-label="新连接名称" value={connectionName} onChange={(event) => onConnectionNameChange(event.currentTarget.value)} />
        <button type="button" className="ghost-button" onClick={onCreateConnection}>新建</button>
      </div>
      <label>
        额度组
        <select value={codex.quotaGroupId} onChange={(event) => onChange(toJsonObject({ ...codex, quotaGroupId: event.currentTarget.value || "codex" }))}>
          {quotaGroupOptions.map((group) => (
            <option key={group.id} value={group.id}>{group.name}</option>
          ))}
        </select>
      </label>
      <div className="split-actions">
        <button type="button" className="ghost-button" onClick={onRefreshConnections}>读取连接</button>
        <button type="button" className="ghost-button" onClick={() => onTestConnection(currentConnection?.id, currentConnection?.revision)}>测试</button>
        {currentConnection ? <button type="button" className="ghost-button" onClick={() => onRefreshConnection(currentConnection.id)}>刷新额度</button> : null}
      </div>
      <ConnectionStatus response={codexSources} test={connectionTest} />
    </section>
  );
}

function ConnectionStatus({ response, test }: { response: CodexConnectionResponse; test: CodexConnectionTestResponse | null }) {
  const read = test ?? response.lastRead;
  if (!read) {
    return <p className="muted-copy">尚无真实读取结果；缺失、未登录、过期和耗尽会按服务端状态分别展示。</p>;
  }
  return (
    <div className={`connection-status ${read.status}`}>
      <strong>{renderCodexStatus(read.status)}</strong>
      <span>{formatDateTime(read.observedAt)}</span>
      {read.error ? (
        <small>{read.error}</small>
      ) : isConnectionTest(read) ? (
        <small>{read.groups.length} 个额度组</small>
      ) : (
        <small>保留最近读取摘要</small>
      )}
    </div>
  );
}

function isConnectionTest(
  read: CodexConnectionResponse["lastRead"] | CodexConnectionTestResponse
): read is CodexConnectionTestResponse {
  return Boolean(read && "groups" in read && Array.isArray(read.groups));
}

function SectionTitle({ title }: { title: string }) {
  return <h3 className="section-title">{title}</h3>;
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      {label}
      <input value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function SelectInput({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map(([optionValue, labelText]) => (
          <option key={optionValue} value={optionValue}>{labelText}</option>
        ))}
      </select>
    </label>
  );
}

function CheckboxInput({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="checkbox-label">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      {label}
    </label>
  );
}

