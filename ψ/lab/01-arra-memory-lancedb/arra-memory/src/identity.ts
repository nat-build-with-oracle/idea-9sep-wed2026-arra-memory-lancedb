/**
 * What this instance calls itself.
 *
 * One deployment of this add-on is "Arra Memory"; another is "thor-memory".
 * The name is identity, not schema — it renames the MCP serverInfo, the UI
 * chrome and the health payload, and never touches the data. Empty falls back
 * to the product name so an unconfigured install still says something true.
 *
 * Its own module because server.ts imports mcp.ts, and both need the name —
 * defining it in either would make the other's import a cycle.
 */
import { setting } from "./config";

export const INSTANCE_NAME = setting("instance_name") || "Arra Memory";
