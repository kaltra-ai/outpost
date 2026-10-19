// Door registry: the outpost dispatches on envelope.door.kind to whatever modules the entry point registered.
// The public build registers the dev door only; a tenant entry (src/entry.<tenant>.ts, git-ignored) adds its platform doors.

import type { DoorModule } from "./sdk";

const doors = new Map<string, DoorModule>();

export function registerDoor(module: DoorModule): void {
  doors.set(module.kind, module);
}

export function doorModule(kind: string): DoorModule | undefined {
  return doors.get(kind);
}

export function registeredDoorKinds(): string[] {
  return [...doors.keys()];
}
