import { parseHostRecord } from "../public/js/host-record.js";
export function assertPublisher(current, config, login, promote = false) {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(config.hostId || ""))
    throw Error("Set a unique hostId in private config before publishing.");
  if (current) {
    const record = parseHostRecord(current);
    if (
      !promote &&
      (record.hostId !== config.hostId || record.publisher !== login)
    )
      throw Error(
        "This computer is a backup. An explicit --promote is required to change the primary host.",
      );
  } else if (!promote) {
    throw Error(
      "No primary host is registered. Use --promote only for an explicitly requested handoff.",
    );
  }
}
