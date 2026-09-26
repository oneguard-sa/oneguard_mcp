import { runAuthed, runStructured, ToolError } from '../cli.js';
import { findByIdPrefix } from '../parsers.js';
import { listLogs, listMembers } from '../structured.js';
import { object, str } from './schema.js';

const ROLES = ['owner', 'admin', 'member', 'finance'];

/** @param {unknown} v @param {string} field */
function requireStr(v, field) {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new ToolError(`${field} is required.`);
  }
  return v.trim();
}

/**
 * Looks a member up so a destructive call can be checked against what is
 * actually there — and so the model has the member's email to read back to the
 * user before anything happens.
 *
 * @param {string} memberIdOrEmail
 * @returns {Promise<{id: string, email: string, role: string}>}
 */
async function resolveMember(memberIdOrEmail) {
  const { rows: members } = await listMembers();
  const needle = memberIdOrEmail.toLowerCase();

  const byEmail = members.find((m) => m.email.toLowerCase() === needle);
  if (byEmail) return byEmail;

  const byId = findByIdPrefix(members, memberIdOrEmail);
  if (byId) return byId;

  throw new ToolError(
    `No member matching "${memberIdOrEmail}". Call oneguard_teams_list to see the members and their exact emails.`,
  );
}

/** @type {import('../rpc.js').ToolDef[]} */
export const orgTools = [
  {
    name: 'oneguard_teams_list',
    title: 'List team members',
    description:
      'Lists the members of the organization with their roles and the 8-character id prefix other team tools accept.',
    inputSchema: object({}),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler() {
      const { rows, raw, structured, ownerCount } = await listMembers();
      return {
        count: rows.length,
        members: rows,
        // Surfaced so the model can see, before proposing a removal or a
        // demotion, that the organization has only one owner left. The server
        // refuses that change outright; this is what lets the agent say so
        // first instead of relaying a 400.
        owner_count: ownerCount,
        structured,
        raw: raw.trim(),
      };
    },
  },
  {
    name: 'oneguard_teams_invite',
    title: 'Invite a team member',
    description:
      'Sends an invitation to join the organization. This emails a real person and grants them access once accepted, so only call it when the user explicitly asked, with the exact address they gave.',
    inputSchema: object(
      {
        email: str('Email address of the person to invite.'),
        role: str(`Role to grant. One of: ${ROLES.join(', ')}.`, {
          enum: ROLES,
          default: 'member',
        }),
      },
      ['email'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    async handler(args) {
      const email = typeof args.email === 'string' ? args.email.trim() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new ToolError(`"${email}" does not look like an email address.`);
      }
      const role = typeof args.role === 'string' ? args.role.trim().toLowerCase() : 'member';
      if (!ROLES.includes(role)) {
        throw new ToolError(`Invalid role "${role}". Use one of: ${ROLES.join(', ')}.`);
      }
      const out = await runAuthed(['teams', 'invite', '--email', email, '--role', role]);
      return { invited: true, email, role, raw: out.trim() };
    },
  },
  {
    name: 'oneguard_teams_set_role',
    title: 'Change a member\'s role',
    description:
      'Changes an existing member\'s role in the organization. Promoting to owner or admin grants broad access to every secret, so confirm the person and the role with the user first. ' +
      'The member can be named by email or by their 8-character id prefix. ' +
      'Note that an admin caller cannot modify owners, other admins, or promote anyone to admin or owner — the server enforces this.',
    inputSchema: object(
      {
        member: str('Member email, or their id / 8-character prefix.'),
        role: str(`The new role. One of: ${ROLES.join(', ')}.`, { enum: ROLES }),
      },
      ['member', 'role'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async handler(args) {
      const member = requireStr(args.member, 'member');
      const role = requireStr(args.role, 'role').toLowerCase();
      if (!ROLES.includes(role)) {
        throw new ToolError(`Invalid role "${role}". Use one of: ${ROLES.join(', ')}.`);
      }

      const found = await resolveMember(member);
      if (found.role === role) {
        return {
          updated: false,
          member: found,
          note: `${found.email} already has the role "${role}". Nothing to do.`,
        };
      }

      const out = await runAuthed([
        'teams', 'role', '--member', found.email, '--role', role,
      ]);
      return {
        updated: true,
        member: { id: found.id, email: found.email },
        previous_role: found.role,
        new_role: role,
        raw: out.trim(),
      };
    },
  },
  {
    name: 'oneguard_teams_remove',
    title: 'Remove a team member',
    description:
      'Removes a member from the organization and revokes their access to every secret in it. This cannot be undone — they would have to be invited again. ' +
      'Only call this after the user explicitly asked for this specific person to be removed, and read their email back to the user first.',
    inputSchema: object(
      {
        member: str('Member email, or their id / 8-character prefix.'),
        confirm: str(
          'Must be exactly the member\'s email address, as a guard against removing the wrong person. Get it from oneguard_teams_list.',
        ),
      },
      ['member', 'confirm'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    async handler(args) {
      const member = requireStr(args.member, 'member');
      const confirm = requireStr(args.confirm, 'confirm');

      const found = await resolveMember(member);
      if (found.email.toLowerCase() !== confirm.toLowerCase()) {
        throw new ToolError(
          `Refusing to remove: confirm was "${confirm}" but "${member}" resolves to ${found.email}. Check with the user which person they mean.`,
        );
      }

      const out = await runAuthed([
        'teams', 'remove', '--member', found.email, '--yes',
      ]);
      return {
        removed: true,
        member: { id: found.id, email: found.email, role: found.role },
        raw: out.trim(),
      };
    },
  },
  {
    name: 'oneguard_logs_list',
    title: 'Read the audit log',
    description:
      'Returns the organization audit log — who did what to which resource, and when. Useful for answering "who changed this secret" questions.',
    inputSchema: object({
      limit: {
        type: 'integer',
        description: 'Return at most this many of the most recent entries.',
        minimum: 1,
        maximum: 500,
        default: 50,
      },
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args) {
      const { rows: all } = await listLogs();
      const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(500, args.limit)) : 50;
      const entries = all.slice(0, limit);
      return { count: entries.length, total: all.length, entries };
    },
  },
];
