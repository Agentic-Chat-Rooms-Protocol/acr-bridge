export interface DaemonMessageResponse {
  id: string;
  room_id: string;
  sender_did: string;
  content: string;
  timestamp: string;
}

export interface ProposalRecord {
  id: string;
  room_id: string;
  author_did: string;
  description: string;
  threshold_pct: number;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  votes?: Record<string, string>;
  dissents?: Array<{ voter_did: string; rationale: string; timestamp: string }>;
  created_at: string;
}

export interface AuditBlock {
  index: number;
  state_hash: string;
  prev_hash: string;
  actor_did: string;
  action: string;
  timestamp: string;
}

export class AcrDaemonClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://127.0.0.1:20443') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async getHealth(): Promise<{ status: string; uptime?: string; active_rooms?: number }> {
    const res = await fetch(`${this.baseUrl}/healthz`);
    if (!res.ok) {
      throw new Error(`Daemon health check failed with HTTP ${res.status}`);
    }
    return res.json() as any;
  }

  async sendMessage(roomId: string, senderDid: string, content: string): Promise<DaemonMessageResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender_did: senderDid,
        content
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to post room message (${res.status}): ${errText}`);
    }
    return res.json() as any;
  }

  async listProposals(): Promise<ProposalRecord[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/proposals`);
    if (!res.ok) {
      throw new Error(`Failed to fetch proposals: HTTP ${res.status}`);
    }
    const data = await res.json() as any;
    return Array.isArray(data) ? data : (data?.proposals || []);
  }

  async getBuddies(did: string): Promise<Array<{ from_did: string; to_did: string; status: string }>> {
    const res = await fetch(`${this.baseUrl}/api/v1/buddies?did=${encodeURIComponent(did)}`);
    if (!res.ok) {
      return [];
    }
    const data = await res.json() as any;
    return Array.isArray(data) ? data : [];
  }

  async castVote(
    proposalId: string,
    voterDid: string,
    ballot: 'APPROVE' | 'REJECT' | 'DISSENT',
    rationale?: string
  ): Promise<{ status: string; proposal: ProposalRecord }> {
    // Enforce GAP-08 mandatory dissent rationale & sanitization
    if (ballot === 'DISSENT') {
      const sanitized = (rationale || '').replace(/[\u200B-\u200D\uFEFF\u2060\u200E\u200F\u00A0]/g, '').trim();
      if (!sanitized) {
        throw new Error('GAP-08 Invariant: A DISSENT vote must include a mandatory rationale statement');
      }
      if (sanitized.length < 10) {
        throw new Error(`GAP-08 Invariant: DISSENT rationale must be substantive (minimum 10 characters required, got ${sanitized.length})`);
      }
      if (sanitized.length > 4096) {
        throw new Error('GAP-08 Invariant: DISSENT rationale exceeds maximum length of 4096 bytes');
      }
      rationale = sanitized;
    }

    const res = await fetch(`${this.baseUrl}/api/v1/proposals/${encodeURIComponent(proposalId)}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voter_did: voterDid,
        choice: ballot,
        rationale: rationale || ''
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Vote rejection (${res.status}): ${errText}`);
    }
    return res.json() as any;
  }

  async resolveEscalation(
    escalationId: string,
    reviewerDid: string,
    approved: boolean,
    reason: string
  ): Promise<{ status: string; escalation_id: string }> {
    const res = await fetch(`${this.baseUrl}/api/v1/escalations/${encodeURIComponent(escalationId)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewer_did: reviewerDid,
        approved,
        reason
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Escalation resolve failed (${res.status}): ${errText}`);
    }
    return res.json() as any;
  }

  async getAuditChain(): Promise<AuditBlock[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/audit/chain`);
    if (!res.ok) {
      throw new Error(`Failed to fetch audit chain: HTTP ${res.status}`);
    }
    const data = await res.json() as any;
    return Array.isArray(data) ? data : (data?.trail || []);
  }
}
