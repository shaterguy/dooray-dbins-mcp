import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { checkCalDav, getEvents, listCalendars, searchEvents } from "./caldav.mjs";
import { checkLdap, getGroupMembers, getPerson, searchPeople } from "./ldap.mjs";
import { toSafeError, toolFailure, toolSuccess } from "./errors.mjs";
import { registerDoorayTools } from "./dooray/register-tools.mjs";

const annotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

const outputSchema = {
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
};

const isoDate = z.string().min(10).max(40).describe("ISO 8601 date-time, including timezone");
const calendarHref = z.string().min(1).max(2048).describe("Calendar href returned by calendar_list_calendars");

function register(server, name, description, inputSchema, handler) {
  server.registerTool(
    name,
    { title: name, description, inputSchema, outputSchema, annotations },
    async (args) => {
      try {
        return await handler(args);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

export function safeConnectionStatus(result) {
  if (result.status === "fulfilled") return { ok: true };
  return { ok: false, error: toSafeError(result.reason) };
}

export function createMcpServer(config) {
  const server = new McpServer({ name: "dooray-dbins-mcp", version: "1.0.0" });

  register(server, "service_status", "Report embedded configuration readiness, optionally testing upstream connections.", {
    testConnections: z.boolean().default(false),
  }, async ({ testConnections }) => {
    const data = {
      ready: true,
      fixedServices: { calendar: "caldav.dooray.co.kr", directory: "ldap.dooray.co.kr:636" },
      connectionsTested: testConnections,
    };
    if (testConnections) {
      const [calendar, directory] = await Promise.allSettled([checkCalDav(config), checkLdap(config)]);
      data.connections = {
        calendar: safeConnectionStatus(calendar),
        directory: safeConnectionStatus(directory),
      };
    }
    return toolSuccess(data, `Service ready; connections tested: ${testConnections}.`);
  });

  register(server, "calendar_list_calendars", "List readable calendars for the configured Dooray account.", {}, async () => {
    const calendars = await listCalendars(config);
    return toolSuccess({ calendars }, `Found ${calendars.length} readable calendar(s).`);
  });

  register(server, "calendar_get_events", "Read calendar events within a bounded date range.", {
    calendarHref,
    start: isoDate,
    end: isoDate,
    limit: z.number().int().min(1).max(100).default(50),
  }, async (args) => {
    const data = await getEvents(config, args);
    return toolSuccess(data, `Found ${data.events.length} event(s) in the requested range.`);
  });

  register(server, "calendar_search_events", "Search event text within a bounded date range.", {
    calendarHref,
    query: z.string().trim().min(1).max(200),
    start: isoDate,
    end: isoDate,
    limit: z.number().int().min(1).max(50).default(25),
  }, async (args) => {
    const data = await searchEvents(config, args);
    return toolSuccess(data, `Found ${data.events.length} matching event(s).`);
  });

  register(server, "directory_search_people", "Search the fixed Dooray LDAP directory using a bounded attribute allowlist.", {
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(50).default(20),
  }, async (args) => {
    const people = await searchPeople(config, args);
    return toolSuccess({ people }, `Found ${people.length} matching person record(s).`);
  });

  register(server, "directory_get_person", "Get one directory person by exact uid, email, or common name.", {
    identifier: z.string().trim().min(1).max(320),
  }, async (args) => {
    const person = await getPerson(config, args);
    return toolSuccess({ person }, "Found one directory person record.");
  });

  register(server, "directory_get_group_members", "List a bounded set of people in one exact directory group.", {
    group: z.string().trim().min(1).max(320),
    limit: z.number().int().min(1).max(20).default(20),
  }, async (args) => {
    const data = await getGroupMembers(config, args);
    return toolSuccess(data, `Found ${data.members.length} group member(s).`);
  });

  registerDoorayTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  return { server, transport };
}
