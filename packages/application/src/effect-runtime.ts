import { Context, Layer } from "effect";

export type ApplicationClock = {
  now(): string;
};

/** Runtime service for application-owned timestamps used by state transitions. */
export class ApplicationClockService extends Context.Service<ApplicationClockService, ApplicationClock>()(
  "@muximo/application/ApplicationClock",
) {}

/** Provides the composition-root clock to clock-dependent application effects. */
export const applicationClockLayer = (clock: ApplicationClock): Layer.Layer<ApplicationClockService> =>
  Layer.succeed(ApplicationClockService, clock);
