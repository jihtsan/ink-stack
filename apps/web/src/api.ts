import type {
  CodexConnectionResponse,
  CodexConnectionTestResponse,
  CodexConnection,
  DashboardDraft,
  DashboardResponse,
  JobResponse,
  WeatherConnectionsResponse,
  WeatherTestResponse,
  WeatherConnection,
  GoogleStatusResponse,
  GoogleCalendarInfo,
  ImageListResponse,
  ImageSource,
  ImageSourcesResponse
} from "./types";

const JSON_HEADERS = {
  "Content-Type": "application/json"
};

type ApiErrorPayload = {
  message?: string;
  error?: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? JSON_HEADERS : undefined),
      ...init?.headers
    }
  });

  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try {
      const payload = (await response.json()) as ApiErrorPayload;
      message = payload.message ?? payload.error ?? message;
    } catch {
      message = response.statusText || message;
    }
    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
}

export const api = {
  async getSession(): Promise<{ authenticated: boolean }> {
    return request("/api/session");
  },

  async login(password: string): Promise<{ ok: true }> {
    return request("/api/session", {
      method: "POST",
      body: JSON.stringify({ password })
    });
  },

  async getDashboard(): Promise<DashboardResponse> {
    return request("/api/dashboards/main");
  },

  async saveDraft(dashboard: DashboardDraft, baseRevision: number): Promise<DashboardResponse> {
    return request("/api/dashboards/main/draft", {
      method: "PUT",
      body: JSON.stringify({ dashboard, baseRevision })
    });
  },

  async createPreview(dashboard: DashboardDraft, editorRevision: number): Promise<JobResponse> {
    return request("/api/dashboards/main/preview", {
      method: "POST",
      body: JSON.stringify({ dashboard, editorRevision })
    });
  },

  async publish(draftRevision: number): Promise<JobResponse> {
    return request("/api/dashboards/main/publish", {
      method: "POST",
      body: JSON.stringify({ draftRevision })
    });
  },

  async getJob(id: string): Promise<JobResponse> {
    return request(`/api/jobs/${encodeURIComponent(id)}`);
  },

  async listCodexConnections(): Promise<CodexConnectionResponse> {
    return request("/api/data-sources");
  },

  async createCodexConnection(name: string): Promise<CodexConnection> {
    return request("/api/data-sources", {
      method: "POST",
      body: JSON.stringify({ name, type: "codex-local", settings: {} })
    });
  },

  async updateCodexConnection(connectionId: string): Promise<CodexConnection> {
    return request(`/api/data-sources/${encodeURIComponent(connectionId)}/versions`, {
      method: "POST",
      body: JSON.stringify({ settings: {} })
    });
  },

  async testCodexConnection(connectionId?: string, connectionRevision?: number): Promise<CodexConnectionTestResponse> {
    return request("/api/data-sources/test", {
      method: "POST",
      body: JSON.stringify(
        connectionId
          ? { connectionId, connectionRevision }
          : { type: "codex-local", settings: {} }
      )
    });
  },

  async refreshCodexConnection(connectionId: string): Promise<CodexConnectionTestResponse> {
    return request(`/api/data-sources/${encodeURIComponent(connectionId)}/refresh`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },

  async createDisplayToken(): Promise<{ url: string }> {
    return request("/api/display-token", {
      method: "POST",
      body: JSON.stringify({})
    });
  },

  async listWeatherConnections(): Promise<WeatherConnectionsResponse> {
    return request("/api/weather-connections");
  },

  async createWeatherConnection(input: { name: string; apiHost: string; authMode: "jwt" | "api-key"; apiKey: string }): Promise<WeatherConnection> {
    return request("/api/weather-connections", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async testWeatherConnection(input: { connectionId?: string; connectionRevision?: number; config: unknown; apiHost?: string; authMode?: "jwt" | "api-key"; apiKey?: string }): Promise<WeatherTestResponse> {
    return request("/api/weather-connections/test", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async listImageSources(): Promise<ImageSourcesResponse> {
    return request("/api/image-sources");
  },

  async createImageSource(input: { type: "album" | "directory"; name: string; root?: string }): Promise<ImageSource> {
    return request("/api/image-sources", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async listImages(sourceId: string, revision: number, recursive: boolean): Promise<ImageListResponse> {
    return request(`/api/image-sources/${encodeURIComponent(sourceId)}/images?revision=${revision}&recursive=${recursive}`);
  },

  async uploadImage(sourceId: string, file: File): Promise<{ source: ImageSource; filename: string }> {
    return request(`/api/image-sources/${encodeURIComponent(sourceId)}/uploads`, {
      method: "POST",
      body: file,
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-InkStack-Filename": encodeURIComponent(file.name)
      }
    });
  },

  async getGoogleStatus(): Promise<GoogleStatusResponse> {
    return request("/api/google/status");
  },

  async saveGoogleApp(clientId: string, clientSecret: string): Promise<{ configured: boolean; clientId?: string }> {
    return request("/api/google/app", { method: "PUT", body: JSON.stringify({ clientId, clientSecret }) });
  },

  async startGoogleOAuth(): Promise<{ url: string }> {
    return request("/api/google/oauth/start");
  },

  async listGoogleCalendars(connectionId: string, revision: number): Promise<{ calendars: GoogleCalendarInfo[] }> {
    return request(`/api/google/connections/${encodeURIComponent(connectionId)}/calendars?revision=${revision}`);
  },

  async getSchedule(): Promise<import("./types").ScheduleState> {
    return request("/api/schedule");
  },

  async saveSchedule(input: { enabled: boolean; cycleSeconds: number }): Promise<import("./types").ScheduleState> {
    return request("/api/schedule", { method: "PUT", body: JSON.stringify(input) });
  }
};
