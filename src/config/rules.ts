/**
 * Security policy schema and default rule set (blueprint Component B).
 *
 * Rules are evaluated in declaration order; the first rule whose `tool` and
 * `condition` both match decides the verdict, so put the sharpest blocks
 * first and use explicit `allow` rules above them to carve out exceptions.
 * A tools/call that no rule claims is forwarded untouched.
 */

import process from 'node:process';

export type RuleAction = 'allow' | 'block' | 'ask';

export type ConditionOperator = 'contains' | 'regex' | 'outside_dir';

export interface RuleCondition {
  /** Dot-path inside the tools/call params, e.g. "arguments.command" or "arguments.path". */
  field: string;
  operator: ConditionOperator;
  value: string;
}

export interface SecurityRule {
  id: string;
  name: string;
  /** Exact tool name (e.g. "run_command", "write_file") or "*" for any tool. */
  tool: string;
  action: RuleAction;
  /** No condition means the rule matches every call to that tool. */
  condition?: RuleCondition;
}

export const defaultRules: SecurityRule[] = [
  // Block high-risk commands entirely.
  {
    id: 'block-destructive',
    name: 'Block Destructive Shell Commands',
    tool: 'run_command',
    action: 'block',
    condition: {
      field: 'arguments.command',
      operator: 'regex',
      // rm with a recursive/force flag anywhere on the line. The pre-flag
      // group accepts ANY whitespace-delimited token, not just dash-flags,
      // because GNU getopt permutes options and operands: `rm file -rf dir`
      // deletes exactly like `rm -rf file dir`. ([^\s]+ and \s+ are disjoint,
      // so each token is consumed at a fixed boundary — no ReDoS.) Plus the
      // blueprint's one-word disasters.
      value:
        '\\brm\\s+(?:[^\\s]+\\s+)*-{1,2}[^\\s]*[rf]|\\b(?:mkfs(?:\\.\\w+)?|dd|shutdown|reboot|halt|poweroff|passwd)\\b',
    },
  },
  // Command-injection detection: every shell metacharacter that can smuggle
  // a second command behind a benign-looking first one.
  {
    id: 'ask-command-chaining',
    name: 'Verify Shell Command Chaining',
    tool: 'run_command',
    action: 'ask',
    condition: {
      field: 'arguments.command',
      operator: 'regex',
      // ;  &  &&  |  ||  backtick  raw newline  $( )  and the redirection
      // operators >  >>  <  (which can clobber files or raw devices, e.g.
      // `echo x > /dev/sda`, without any chaining metacharacter).
      value: '[;&|`\\n<>]|\\$\\(',
    },
  },
  // Hold network actions for manual approval.
  {
    id: 'ask-network',
    name: 'Verify Network Command Execution',
    tool: 'run_command',
    action: 'ask',
    condition: {
      field: 'arguments.command',
      operator: 'regex',
      value: '\\b(?:curl|wget|nc|ssh|ftp|ping|telnet|nmap)\\b',
    },
  },
  // Ensure workspace boundaries for file writes.
  {
    id: 'protect-system-dirs',
    name: 'Restrict File Writes to Workspace',
    tool: 'write_file',
    action: 'ask',
    condition: {
      field: 'arguments.path',
      operator: 'outside_dir',
      value: process.cwd(),
    },
  },
];
