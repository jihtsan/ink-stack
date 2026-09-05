export interface WeatherConfig {
  title: string;
  locationMode: "city" | "coordinates";
  city: string;
  latitude: number;
  longitude: number;
  units: "m" | "i";
  connectionId: string;
  connectionRevision: number;
  showTemperature: boolean;
  showCondition: boolean;
  showFeelsLike: boolean;
  showHumidity: boolean;
  showWind: boolean;
  showForecast: boolean;
  showUpdatedAt: boolean;
  refreshSeconds: number;
  cacheTtlSeconds: number;
  maxStaleSeconds: number;
}

export type WeatherError = "connection" | "authentication" | "location" | "timeout" | "network" | "response";

/** This is the only provider data allowed into render jobs. Never include a raw response. */
export interface WeatherSnapshot {
  location: string;
  units: "m" | "i";
  observedAt: string;
  temperature: number;
  condition: string;
  feelsLike?: number;
  humidity?: number;
  windSpeed?: number;
  forecastError?: WeatherError;
  forecast: { date: string; minimum: number; maximum: number; condition: string }[];
}

export interface WeatherEnvelope {
  status: "fresh" | "stale" | "unavailable" | "unauthenticated";
  reason?: "missing" | "expired" | WeatherError;
  observedAt?: string;
  staleAt?: string;
  data?: WeatherSnapshot;
}
