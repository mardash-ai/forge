import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The path-scoped IP allow-list (HAT-PLAN-003 §13 q14).
 *
 * A wrong CEL expression here is how an allow-list locks out everyone including the operator who
 * applied it, so the shape of the generated rule is asserted rather than eyeballed. Terraform's own
 * `validate` proves it PARSES; these assert it means what it should.
 */

const SRC = readFileSync(join(process.cwd(), 'terraform/modules/backend/main.tf'), 'utf8');

describe('backend module — restricted_paths', () => {
  it('is DEFAULT OFF, and off means no resource at all', () => {
    // A capability that ships enforcing something locks somebody out on the day it lands. `count`
    // on an empty list means applying this module changes nothing until an operator opts in.
    expect(SRC).toContain('default = { paths = [], allow_cidrs = [] }');
    expect(SRC).toContain('count   = local.armor_enabled ? 1 : 0');
    expect(SRC).toContain('armor_enabled = length(var.restricted_paths.paths) > 0');
  });

  it('REFUSES paths with no allow_cidrs at plan time', () => {
    // Paths with no ranges denies everyone. Failing at plan is the difference between a typo and
    // an outage.
    expect(SRC).toMatch(
      /condition\s*=\s*length\(var\.restricted_paths\.paths\) == 0 \|\| length\(var\.restricted_paths\.allow_cidrs\) > 0/,
    );
  });

  it('denies only the RESTRICTED PATHS, and leaves the rest of the API alone', () => {
    /*
     * The load-bearing detail. One backend service fronts the whole app, so a naive allow-list on
     * the backend would gate every route the product has — including the browser. The rule is
     * therefore path-scoped, and the default rule is an explicit allow.
     */
    expect(SRC).toContain("request.path.startsWith('${p}')");
    expect(SRC).toContain('action   = "deny(403)"');
    expect(SRC).toContain('action   = "allow"');
    expect(SRC).toContain('src_ip_ranges = ["*"]');
  });

  it('the deny fires when the path matches AND the ip is OUTSIDE the list', () => {
    // `&&` with a negated inIpRange — not `||`, which would deny every request to any path, and not
    // an un-negated range check, which would deny exactly the callers meant to be allowed.
    const expr = SRC.slice(SRC.indexOf('expression = join('), SRC.indexOf('description = "restricted paths'));
    expect(expr).toContain('join(" && "');
    expect(expr).toContain('!(inIpRange(origin.ip');
    expect(expr).toContain('" || "'); // multiple paths OR together
  });

  it('attaches the policy to the backend service, and only when enabled', () => {
    expect(SRC).toContain(
      'security_policy = local.armor_enabled ? google_compute_security_policy.paths[0].id : null',
    );
  });
});
