import { eventIterator, oc } from "@orpc/contract";
import {
  authChallengeRequestSchema,
  authChallengeResponseSchema,
  authInfoSchema,
  authSessionRequestSchema,
  authSessionResponseSchema,
  createPaneRequestSchema,
  createSessionRequestSchema,
  muximodCapabilitiesSchema,
  muximodEventSchema,
  muximodHealthSchema,
  paneListResponseSchema,
  paneResponseSchema,
  pairingClaimRequestSchema,
  pairingClaimResponseSchema,
  pairingStatusSchema,
  registerWorkspaceRequestSchema,
  sessionListResponseSchema,
  sessionResponseSchema,
  terminalListResponseSchema,
  updateWorkspaceRequestSchema,
  workspaceBrowseResponseSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  wsTicketRequestSchema,
  wsTicketResponseSchema,
} from "./protocol.js";
import { z } from "zod";
import { WorkspaceId } from "@muximo/domain";

const emptyInput = z.object({}).strict();
const pairingIdInput = z.object({ pairingId: z.string().trim().min(1).max(256) }).strict();
const workspaceIdInput = z.object({ workspaceId: WorkspaceId.valueSchema }).strict();
const workspaceBrowseInput = z.object({ path: z.string().trim().max(4_096).optional() }).strict();
const paneListInput = z.object({ session: z.string().trim().min(1).max(64).optional() }).strict();
const pairingClaimInput = z.object({
  pairingId: z.string().trim().min(1).max(256),
  request: pairingClaimRequestSchema,
}).strict();
const pairingStatusInput = z.object({
  pairingId: z.string().trim().min(1).max(256),
  claimToken: z.string().min(1).max(512),
}).strict();

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
    update: oc.input(workspaceIdInput.extend({ input: updateWorkspaceRequestSchema })).output(workspaceResponseSchema),
    delete: oc.input(workspaceIdInput).output(emptyInput),
  },
  terminals: {
    list: oc.input(emptyInput).output(terminalListResponseSchema),
  },
  sessions: {
    list: oc.input(emptyInput).output(sessionListResponseSchema),
    create: oc.input(createSessionRequestSchema).output(sessionResponseSchema),
  },
  panes: {
    list: oc.input(paneListInput).output(paneListResponseSchema),
    create: oc.input(createPaneRequestSchema).output(paneResponseSchema),
  },
  events: {
    subscribe: oc.input(emptyInput).output(eventIterator(muximodEventSchema)),
  },
} as const;

export type MuximodContract = typeof muximodContract;
