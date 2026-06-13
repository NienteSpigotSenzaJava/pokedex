import { redactSecrets } from '@pokedex/security';
import type { AppServerEvent, JsonRecord, RpcId } from './types.js';
import { asRecord, isRpcId, stringArrayFrom, stringFrom, stripUndefined } from './utils.js';

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export type PendingApproval = {
  approvalId: string;
  requestId: RpcId;
  kind: 'command' | 'file';
  method: string;
  createdAt: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  reason?: string;
  command?: string[];
  commandText?: string;
  cwd?: string;
  grantRoot?: string;
  availableDecisions?: string[];
  raw: unknown;
};

export class ApprovalStore {
  private nextApprovalId = 1;
  private readonly approvals = new Map<string, PendingApproval>();

  handleEvent(event: AppServerEvent): void {
    const message = asRecord(event.raw);
    if (isRpcId(message.id)) this.trackRequest(message.id, message);
    this.clearResolved(message);
  }

  clear(): void {
    this.approvals.clear();
  }

  delete(approvalId: string): void {
    this.approvals.delete(approvalId);
  }

  list(): unknown[] {
    return [...this.approvals.values()].map((approval) => redactSecrets(publicApproval(approval)));
  }

  find(approvalId: string | undefined): PendingApproval | null {
    if (approvalId) return this.approvals.get(approvalId) ?? null;
    return this.approvals.size === 1 ? [...this.approvals.values()][0]! : null;
  }

  findForThread(threadId: string | undefined): PendingApproval | null {
    return (
      [...this.approvals.values()].find((approval) => approvalMatchesThread(approval, threadId)) ??
      null
    );
  }

  findByRequestId(requestId: RpcId): PendingApproval | null {
    return (
      [...this.approvals.values()].find((approval) => approval.requestId === requestId) ?? null
    );
  }

  private trackRequest(requestId: RpcId, message: JsonRecord): void {
    const method = stringFrom(message.method);
    if (
      method !== 'item/commandExecution/requestApproval' &&
      method !== 'item/fileChange/requestApproval'
    ) {
      return;
    }

    const existing = this.findByRequestId(requestId);
    const params = asRecord(message.params);
    const command = stringArrayFrom(params.command);
    const approval = stripUndefined({
      approvalId: existing?.approvalId ?? `approval-${this.nextApprovalId++}`,
      requestId,
      kind: method.includes('commandExecution') ? 'command' : 'file',
      method,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      threadId: stringFrom(params.threadId),
      turnId: stringFrom(params.turnId),
      itemId: stringFrom(params.itemId),
      reason: stringFrom(params.reason),
      command,
      commandText: command?.join(' '),
      cwd: stringFrom(params.cwd),
      grantRoot: stringFrom(params.grantRoot),
      availableDecisions: stringArrayFrom(params.availableDecisions),
      raw: redactSecrets(message),
    }) as PendingApproval;
    this.approvals.set(approval.approvalId, approval);
  }

  private clearResolved(message: JsonRecord): void {
    if (message.method !== 'serverRequest/resolved') return;
    const requestId = asRecord(message.params).requestId;
    if (!isRpcId(requestId)) return;
    for (const approval of this.approvals.values()) {
      if (approval.requestId === requestId) this.approvals.delete(approval.approvalId);
    }
  }
}

export function publicApproval(approval: PendingApproval): JsonRecord {
  return stripUndefined({
    approvalId: approval.approvalId,
    kind: approval.kind,
    threadId: approval.threadId,
    turnId: approval.turnId,
    itemId: approval.itemId,
    reason: approval.reason,
    command: approval.command,
    commandText: approval.commandText,
    cwd: approval.cwd,
    grantRoot: approval.grantRoot,
    availableDecisions: approval.availableDecisions,
    createdAt: approval.createdAt,
  });
}

export function approvalWaitMessage(approval: PendingApproval): string {
  const target =
    approval.kind === 'command'
      ? approval.commandText || 'a command'
      : approval.grantRoot || 'file changes';
  return `codex is waiting for approval: ${target}. inspect pending approvals before asking the user to approve or decline.`;
}

export function approvalMatchesThread(
  approval: PendingApproval,
  threadId: string | undefined
): boolean {
  return !threadId || !approval.threadId || approval.threadId === threadId;
}
