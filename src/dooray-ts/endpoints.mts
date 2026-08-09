import { clampPage, clampPageSize, requireIdentifier } from "./guards.mjs";
import type { DoorayQuery, DoorayRequestTarget } from "./types.mjs";

function pagination(page?: number, size?: number, fallbackSize = 20): DoorayQuery {
  return { page: clampPage(page), size: clampPageSize(size, fallbackSize) };
}

export type CommonOperation = "me" | "members" | "member" | "incoming_hook";
export interface CommonArgs {
  operation: CommonOperation;
  memberId?: string;
  incomingHookId?: string;
  name?: string;
  userCode?: string;
  userCodeExact?: string;
  idProviderUserId?: string;
  externalEmails?: string[];
  page?: number;
  size?: number;
}

export function resolveCommonTarget(args: CommonArgs): DoorayRequestTarget {
  switch (args.operation) {
    case "me":
      return { path: "/common/v1/members/me" };
    case "members":
      return {
        path: "/common/v1/members",
        query: {
          ...pagination(args.page, args.size),
          name: args.name,
          userCode: args.userCode,
          userCodeExact: args.userCodeExact,
          idProviderUserId: args.idProviderUserId,
          externalEmails: args.externalEmails,
        },
      };
    case "member":
      return { path: `/common/v1/members/${requireIdentifier("memberId", args.memberId)}` };
    case "incoming_hook":
      return { path: `/common/v1/incomingHooks/${requireIdentifier("incomingHookId", args.incomingHookId)}` };
  }
}

export type ProjectOperation =
  | "list_projects"
  | "project"
  | "is_creatable"
  | "workflows"
  | "email_address"
  | "milestones"
  | "milestone"
  | "tags"
  | "tag"
  | "members"
  | "member"
  | "member_groups"
  | "member_group"
  | "templates"
  | "template";

export interface ProjectArgs {
  operation: ProjectOperation;
  projectId?: string;
  code?: string;
  emailAddressId?: string;
  milestoneId?: string;
  tagId?: string;
  memberId?: string;
  memberGroupId?: string;
  templateId?: string;
  member?: string;
  state?: string;
  scope?: string;
  status?: string;
  roles?: string[];
  interpolation?: boolean;
  page?: number;
  size?: number;
}

export function resolveProjectTarget(args: ProjectArgs): DoorayRequestTarget {
  const projectId = args.projectId ? requireIdentifier("projectId", args.projectId) : undefined;
  switch (args.operation) {
    case "list_projects":
      return {
        path: "/project/v1/projects",
        query: {
          ...pagination(args.page, args.size),
          member: args.member || "me",
          state: args.state || "active",
          scope: args.scope,
        },
      };
    case "project":
      return { path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}` };
    case "is_creatable":
      return { path: "/project/v1/projects/is-creatable", query: { code: requireIdentifier("code", args.code) } };
    case "workflows":
      return { path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}/workflows` };
    case "email_address":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}/email-addresses/${requireIdentifier("emailAddressId", args.emailAddressId)}`,
      };
    case "milestones":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}/milestones`,
        query: { ...pagination(args.page, args.size), status: args.status },
      };
    case "milestone":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}/milestones/${requireIdentifier("milestoneId", args.milestoneId)}`,
      };
    case "tags":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}/tags`,
        query: pagination(args.page, args.size, 100),
      };
    case "tag":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}/tags/${requireIdentifier("tagId", args.tagId)}`,
      };
    case "members":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}/members`,
        query: { ...pagination(args.page, args.size), roles: args.roles },
      };
    case "member":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}/members/${requireIdentifier("memberId", args.memberId)}`,
      };
    case "member_groups":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}/member-groups`,
        query: pagination(args.page, args.size),
      };
    case "member_group":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}/member-groups/${requireIdentifier("memberGroupId", args.memberGroupId)}`,
      };
    case "templates":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}/templates`,
        query: pagination(args.page, args.size),
      };
    case "template":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", projectId)}/templates/${requireIdentifier("templateId", args.templateId)}`,
        query: { interpolation: args.interpolation },
      };
  }
}

export type TaskOperation = "list_tasks" | "task" | "comments" | "attachments" | "attachment_metadata";
export interface TaskArgs {
  operation: TaskOperation;
  projectId?: string;
  taskId?: string;
  fileId?: string;
  fromEmailAddress?: string;
  fromMemberIds?: string[];
  toMemberIds?: string[];
  ccMemberIds?: string[];
  tagIds?: string[];
  parentPostId?: string;
  postNumber?: number;
  postWorkflowClasses?: string[];
  postWorkflowIds?: string[];
  milestoneIds?: string[];
  subjects?: string;
  createdAt?: string;
  updatedAt?: string;
  dueAt?: string;
  order?: string;
  page?: number;
  size?: number;
}

export function resolveTaskTarget(args: TaskArgs): DoorayRequestTarget {
  const taskId = args.taskId ? requireIdentifier("taskId", args.taskId) : undefined;
  switch (args.operation) {
    case "list_tasks":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", args.projectId)}/posts`,
        query: {
          ...pagination(args.page, args.size),
          fromEmailAddress: args.fromEmailAddress,
          fromMemberIds: args.fromMemberIds,
          toMemberIds: args.toMemberIds,
          ccMemberIds: args.ccMemberIds,
          tagIds: args.tagIds,
          parentPostId: args.parentPostId,
          postNumber: args.postNumber,
          postWorkflowClasses: args.postWorkflowClasses,
          postWorkflowIds: args.postWorkflowIds,
          milestoneIds: args.milestoneIds,
          subjects: args.subjects,
          createdAt: args.createdAt,
          updatedAt: args.updatedAt,
          dueAt: args.dueAt,
          order: args.order,
        },
      };
    case "task":
      return args.projectId
        ? { path: `/project/v1/projects/${requireIdentifier("projectId", args.projectId)}/posts/${requireIdentifier("taskId", taskId)}` }
        : { path: `/project/v1/posts/${requireIdentifier("taskId", taskId)}` };
    case "comments":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", args.projectId)}/posts/${requireIdentifier("taskId", taskId)}/logs`,
        query: pagination(args.page, args.size),
      };
    case "attachments":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", args.projectId)}/posts/${requireIdentifier("taskId", taskId)}/files`,
        query: pagination(args.page, args.size),
      };
    case "attachment_metadata":
      return {
        path: `/project/v1/projects/${requireIdentifier("projectId", args.projectId)}/posts/${requireIdentifier("taskId", taskId)}/files/${requireIdentifier("fileId", args.fileId)}`,
        query: { media: "meta" },
      };
  }
}

export type MessengerOperation = "channels";
export interface MessengerArgs { operation: MessengerOperation; page?: number; size?: number }
export function resolveMessengerTarget(args: MessengerArgs): DoorayRequestTarget {
  return { path: "/messenger/v1/channels", query: pagination(args.page, args.size) };
}

export type CalendarOperation = "events" | "event" | "raw_calendars";
export interface CalendarArgs {
  operation: CalendarOperation;
  calendarId?: string;
  eventId?: string;
  calendars?: string[];
  category?: string;
  timeMin?: string;
  timeMax?: string;
  page?: number;
  size?: number;
}
export function resolveCalendarTarget(args: CalendarArgs): DoorayRequestTarget {
  switch (args.operation) {
    case "events":
      return {
        path: "/calendar/v1/calendars/*/events",
        query: {
          ...pagination(args.page, args.size),
          calendars: args.calendars,
          category: args.category || "general",
          timeMin: args.timeMin,
          timeMax: args.timeMax,
        },
      };
    case "event":
      return {
        path: `/calendar/v1/calendars/${requireIdentifier("calendarId", args.calendarId)}/events/${requireIdentifier("eventId", args.eventId)}`,
      };
    case "raw_calendars":
      return { path: "/calendar/v1/calendars", query: pagination(args.page, args.size) };
  }
}

export type WikiOperation = "wikis" | "pages" | "page" | "page_by_wiki" | "comments" | "comment";
export interface WikiArgs {
  operation: WikiOperation;
  wikiId?: string;
  pageId?: string;
  parentPageId?: string;
  commentId?: string;
  page?: number;
  size?: number;
}
export function resolveWikiTarget(args: WikiArgs): DoorayRequestTarget {
  switch (args.operation) {
    case "wikis":
      return { path: "/wiki/v1/wikis", query: pagination(args.page, args.size) };
    case "pages":
      return {
        path: `/wiki/v1/wikis/${requireIdentifier("wikiId", args.wikiId)}/pages`,
        query: { parentPageId: args.parentPageId },
      };
    case "page":
      return { path: `/wiki/v1/pages/${requireIdentifier("pageId", args.pageId)}` };
    case "page_by_wiki":
      return {
        path: `/wiki/v1/wikis/${requireIdentifier("wikiId", args.wikiId)}/pages/${requireIdentifier("pageId", args.pageId)}`,
      };
    case "comments":
      return {
        path: `/wiki/v1/wikis/${requireIdentifier("wikiId", args.wikiId)}/pages/${requireIdentifier("pageId", args.pageId)}/comments`,
        query: pagination(args.page, args.size),
      };
    case "comment":
      return {
        path: `/wiki/v1/wikis/${requireIdentifier("wikiId", args.wikiId)}/pages/${requireIdentifier("pageId", args.pageId)}/comments/${requireIdentifier("commentId", args.commentId)}`,
      };
  }
}

export type DriveOperation = "drives" | "files" | "file_metadata";
export interface DriveArgs {
  operation: DriveOperation;
  driveId?: string;
  fileId?: string;
  parentId?: string;
  type?: string;
  subTypes?: string[];
  scope?: string;
  state?: string;
  projectId?: string;
  page?: number;
  size?: number;
}
export function resolveDriveTarget(args: DriveArgs): DoorayRequestTarget {
  switch (args.operation) {
    case "drives":
      return {
        path: "/drive/v1/drives",
        query: {
          ...pagination(args.page, args.size),
          type: args.type,
          scope: args.scope,
          state: args.state,
          projectId: args.projectId,
        },
      };
    case "files":
      return {
        path: `/drive/v1/drives/${requireIdentifier("driveId", args.driveId)}/files`,
        query: {
          ...pagination(args.page, args.size),
          parentId: args.parentId,
          type: args.type,
          subTypes: args.subTypes,
        },
      };
    case "file_metadata":
      return {
        path: `/drive/v1/files/${requireIdentifier("fileId", args.fileId)}`,
        query: { media: "meta" },
      };
  }
}
