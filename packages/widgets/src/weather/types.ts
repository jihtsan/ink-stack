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
  /** The secondary pane shown on wide weather cards. Missing means daily for legacy configs. */
  forecastMode?: "daily" | "hourly" | "air-quality";
  showUpdatedAt: boolean;
  refreshSeconds: number;
  cacheTtlSeconds: number;
  maxStaleSeconds: number;
}

export type WeatherError = "connection" | "authentication" | "location" | "timeout" | "network" | "response";

export interface WeatherHourlyForecast {
  time: string;
  temperature: number;
  condition: string;
  feelsLike?: number;
  humidity?: number;
  windSpeed?: number;
}

export interface WeatherAirQuality {
  aqi?: number;
  aqiDisplay: string;
  level?: string;
  category: string;
  primaryPollutant?: string;
  pollutants: { code: string; name: string; value: number; unit: string }[];
}

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
  hourlyError?: WeatherError;
  airQualityError?: WeatherError;
  forecast: { date: string; minimum: number; maximum: number; condition: string }[];
  hourlyForecast: WeatherHourlyForecast[];
  airQuality?: WeatherAirQuality;
}

export interface WeatherEnvelope {
  status: "fresh" | "stale" | "unavailable" | "unauthenticated";
  reason?: "missing" | "expired" | WeatherError;
  observedAt?: string;
  staleAt?: string;
  data?: WeatherSnapshot;
}
