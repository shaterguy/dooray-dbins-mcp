import { z } from "zod";
import { loadDoorayRuntimeConfig } from "../config.mjs";
import { DoorayClient } from "./client.mjs";
import {
  resolveCalendarTarget,
  resolveCommonTarget,
  resolveDriveTarget,
  resolveMessengerTarget,
  resolveProjectTarget,
  resolveTaskTarget,
  resolveWikiTarget,
} from "./endpoints.mjs";
import { errorResult, successResult } from "./tool-result.mjs";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const queryScalar = z.union([z.string(), z.number(), z.boolean()]);
const queryValue = z.union([queryScalar, z.array(queryScalar)]);

function createClient() {
  const config = loadDoorayRuntimeConfig();
  return {
    client: new DoorayClient({
      token: config.apiToken,
      baseUrl: config.baseUrl,
      allowedHosts: config.allowedHosts,
      timeoutMs: config.timeoutMs,
      maxResponseBytes: config.maxResponseBytes,
    }),
    maxToolTextChars: config.maxToolTextChars,
  };
}

async function execute(target: { path: string; query?: Record<string, unknown> }) {
  try {
    const { client, maxToolTextChars } = createClient();
    const data = await client.get(target.path, target.query as never);
    return successResult(data, maxToolTextChars);
  } catch (error) {
    return errorResult(error);
  }
}

export function registerDoorayTools(server: any): void {
  server.registerTool(
    "dooray_check_connection",
    {
      title: "Check Dooray MCP connection",
      description: "Verify that the Dooray read-only MCP server is reachable without calling Dooray.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => successResult({ ok: true, server: "dooray-dbins-mcp", version: "1.0.0" }, 20_000)
  );

  server.registerTool(
    "dooray_whoami",
    {
      title: "Get my Dooray member information",
      description: "Validate the configured Dooray API token and return the authenticated member profile.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => execute({ path: "/common/v1/members/me" })
  );

  server.registerTool(
    "dooray_common",
    {
      title: "Read Dooray common and member data",
      description: "Read the current member, member directory, one member, or an incoming-hook definition.",
      inputSchema: z.object({
        operation: z.enum(["me", "members", "member", "incoming_hook"]),
        memberId: z.string().optional(),
        incomingHookId: z.string().optional(),
        name: z.string().optional(),
        userCode: z.string().optional(),
        userCodeExact: z.string().optional(),
        idProviderUserId: z.string().optional(),
        externalEmails: z.array(z.string()).optional(),
        page: z.number().int().optional(),
        size: z.number().int().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args: any) => execute(resolveCommonTarget(args))
  );

  server.registerTool(
    "dooray_projects",
    {
      title: "Read Dooray projects and project configuration",
      description: "Read projects, workflows, milestones, tags, members, member groups, templates, and project email-address metadata.",
      inputSchema: z.object({
        operation: z.enum(["list_projects", "project", "is_creatable", "workflows", "email_address", "milestones", "milestone", "tags", "tag", "members", "member", "member_groups", "member_group", "templates", "template"]),
        projectId: z.string().optional(),
        code: z.string().optional(),
        emailAddressId: z.string().optional(),
        milestoneId: z.string().optional(),
        tagId: z.string().optional(),
        memberId: z.string().optional(),
        memberGroupId: z.string().optional(),
        templateId: z.string().optional(),
        member: z.string().optional(),
        state: z.string().optional(),
        scope: z.string().optional(),
        status: z.string().optional(),
        roles: z.array(z.string()).optional(),
        interpolation: z.boolean().optional(),
        page: z.number().int().optional(),
        size: z.number().int().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args: any) => execute(resolveProjectTarget(args))
  );

  server.registerTool(
    "dooray_tasks",
    {
      title: "Read Dooray tasks, comments, and attachment metadata",
      description: "Search tasks with Dooray filters, read task details and comments, and read attachment lists or metadata. File content is not downloaded.",
      inputSchema: z.object({
        operation: z.enum(["list_tasks", "task", "comments", "attachments", "attachment_metadata"]),
        projectId: z.string().optional(),
        taskId: z.string().optional(),
        fileId: z.string().optional(),
        fromEmailAddress: z.string().optional(),
        fromMemberIds: z.array(z.string()).optional(),
        toMemberIds: z.array(z.string()).optional(),
        ccMemberIds: z.array(z.string()).optional(),
        tagIds: z.array(z.string()).optional(),
        parentPostId: z.string().optional(),
        postNumber: z.number().int().optional(),
        postWorkflowClasses: z.array(z.string()).optional(),
        postWorkflowIds: z.array(z.string()).optional(),
        milestoneIds: z.array(z.string()).optional(),
        subjects: z.string().optional(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        dueAt: z.string().optional(),
        order: z.string().optional(),
        page: z.number().int().optional(),
        size: z.number().int().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args: any) => execute(resolveTaskTarget(args))
  );

  server.registerTool(
    "dooray_messenger",
    {
      title: "Read Dooray Messenger channels",
      description: "Read the list of Messenger channels available to the authenticated member.",
      inputSchema: z.object({ operation: z.literal("channels"), page: z.number().int().optional(), size: z.number().int().optional() }),
      annotations: readOnlyAnnotations,
    },
    async (args: any) => execute(resolveMessengerTarget(args))
  );

  server.registerTool(
    "dooray_calendar",
    {
      title: "Read Dooray calendars and events",
      description: "Read calendar metadata, events in a time range, or one event. For range queries, provide calendars, timeMin, and timeMax.",
      inputSchema: z.object({
        operation: z.enum(["events", "event", "raw_calendars"]),
        calendarId: z.string().optional(),
        eventId: z.string().optional(),
        calendars: z.array(z.string()).optional(),
        category: z.string().optional(),
        timeMin: z.string().optional(),
        timeMax: z.string().optional(),
        page: z.number().int().optional(),
        size: z.number().int().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args: any) => execute(resolveCalendarTarget(args))
  );

  server.registerTool(
    "dooray_wiki",
    {
      title: "Read Dooray wikis, pages, and comments",
      description: "Read wiki lists, page lists, page details, comment lists, and one comment.",
      inputSchema: z.object({
        operation: z.enum(["wikis", "pages", "page", "page_by_wiki", "comments", "comment"]),
        wikiId: z.string().optional(),
        pageId: z.string().optional(),
        parentPageId: z.string().optional(),
        commentId: z.string().optional(),
        page: z.number().int().optional(),
        size: z.number().int().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args: any) => execute(resolveWikiTarget(args))
  );

  server.registerTool(
    "dooray_drive",
    {
      title: "Read Dooray Drive metadata",
      description: "Read drives, list files or folders, and read file metadata. File content is not downloaded.",
      inputSchema: z.object({
        operation: z.enum(["drives", "files", "file_metadata"]),
        driveId: z.string().optional(),
        fileId: z.string().optional(),
        parentId: z.string().optional(),
        type: z.string().optional(),
        subTypes: z.array(z.string()).optional(),
        scope: z.string().optional(),
        state: z.string().optional(),
        projectId: z.string().optional(),
        page: z.number().int().optional(),
        size: z.number().int().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args: any) => execute(resolveDriveTarget(args))
  );

  server.registerTool(
    "dooray_api_get",
    {
      title: "Read any Dooray REST API endpoint",
      description: "GET-only fallback for documented Dooray endpoints not yet represented by a dedicated tool. The host is fixed by DOORAY_BASE_URL, path traversal is rejected, redirects are rejected, and binary responses are blocked.",
      inputSchema: z.object({
        path: z.string().describe("Dooray API path in /<service>/v<number>/... form"),
        query: z.record(queryValue).optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ path, query }: { path: string; query?: Record<string, unknown> }) => execute({ path, query })
  );

  server.registerTool(
    "dooray_capabilities",
    {
      title: "List Dooray MCP read capabilities",
      description: "Return the curated read operations and the security constraints of this MCP server.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => successResult({
      mode: "read-only",
      httpMethod: "GET only",
      dedicatedTools: ["dooray_common", "dooray_projects", "dooray_tasks", "dooray_messenger", "dooray_calendar", "dooray_wiki", "dooray_drive"],
      genericFallback: "dooray_api_get",
      binaryDownloads: false,
      redirects: false,
      maxPageSize: 100,
    }, 40_000)
  );
}
