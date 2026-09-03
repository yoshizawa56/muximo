import { eventIterator, oc } from "@orpc/contract";
import { Schema } from "effect";
import {
  agentSessionListResponseSchema,
  authChallengeRequestSchema,
  authChallengeResponseSchema,
  authInfoSchema,
  authSessionRequestSchema,
  authSessionResponseSchema,
  cleanupAgentSessionRequestSchema,
  cleanupAgentSessionResponseSchema,
  createPaneRequestSchema,
  createSessionRequestSchema,
  listAgentSessionsRequestSchema,
  managedSessionResponseSchema,
  manageSessionRequestSchema,
  muximodCapabilitiesSchema,
  muximodEventSchema,
  muximodHealthSchema,
  pairingClaimRequestSchema,
  pairingClaimResponseSchema,
  pairingStatusSchema,
  paneListResponseSchema,
  paneResponseSchema,
  registerWorkspaceRequestSchema,
  sessionListResponseSchema,
  sessionResponseSchema,
  struct,
  terminalListResponseSchema,
  updateWorkspaceRequestSchema,
  workspaceBrowseResponseSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  wsTicketRequestSchema,
  wsTicketResponseSchema,
} from "./protocol.js";

const emptyInput = struct({});
const workspaceIdField = Schema.String.check(Schema.isMinLength(1));
const workspaceIdInput = struct({ workspaceId: workspaceIdField });
const workspaceBrowseInput = struct({
  path: Schema.optional(Schema.Trim.check(Schema.isMaxLength(4_096))),
});
const paneListInput = struct({
  session: Schema.optional(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
});
const pairingClaimInput = struct({
  pairingId: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  request: pairingClaimRequestSchema,
});
const pairingStatusInput = struct({
  pairingId: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  claimToken: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});

export const muximodContract = {
  health: oc.input(emptyInput).output(muximodHealthSchema),
  capabilities: oc.input(emptyInput).output(muximodCapabilitiesSchema),
  auth: {
    info: oc.input(emptyInput).output(authInfoSchema),
    claimPairing: oc.input(pairingClaimInput).output(pairingClaimResponseSchema),
    pairingStatus: oc.input(pairingStatusInput).output(pairingStatusSchema),
    createChallenge: oc.input(authChallengeRequestSchema).output(authChallengeResponseSchema),
    createSession: oc.input(authSessionRequestSchema).output(authSessionResponseSchema),
    issueWebSocketTicket: oc.input(wsTicketRequestSchema).output(wsTicketResponseSchema),
  },
  workspaces: {
    list: oc.input(emptyInput).output(workspaceListResponseSchema),
    browse: oc.input(workspaceBrowseInput).output(workspaceBrowseResponseSchema),
    register: oc.input(registerWorkspaceRequestSchema).output(workspaceResponseSchema),
    update: oc
      .input(struct({ workspaceId: workspaceIdField, input: updateWorkspaceRequestSchema }))
      .output(workspaceResponseSchema),
    delete: oc.input(workspaceIdInput).output(emptyInput),
  },
  terminals: {
    list: oc.input(emptyInput).output(terminalListResponseSchema),
  },
  sessions: {
    list: oc.input(emptyInput).output(sessionListResponseSchema),
    create: oc.input(createSessionRequestSchema).output(sessionResponseSchema),
    manage: oc.input(manageSessionRequestSchema).output(managedSessionResponseSchema),
  },
  panes: {
    list: oc.input(paneListInput).output(paneListResponseSchema),
    create: oc.input(createPaneRequestSchema).output(paneResponseSchema),
  },
  agentSessions: {
    cleanup: oc.input(cleanupAgentSessionRequestSchema).output(cleanupAgentSessionResponseSchema),
    list: oc.input(listAgentSessionsRequestSchema).output(agentSessionListResponseSchema),
  },
  events: {
    subscribe: oc.input(emptyInput).output(eventIterator(muximodEventSchema)),
  },
} as const;

export type MuximodContract = typeof muximodContract;
