import { readFile } from 'node:fs/promises';

// Heuristic failure analysis. NOT AI-powered for v1 — a set of ordered pattern
// matchers over build/test/lint logs. The value is token reduction: instead of
// dumping 5000 lines into a model, Forge returns a compact diagnostic locally.

export interface Diagnosis {
  likely_cause: string;
  evidence: string[];
  file_refs: string[];
  suggested_actions: string[];
}

interface Matcher {
  // Return a partial diagnosis if this matcher fires.
  match(lines: string[]): Diagnosis | null;
}

// Extract "file:line" or "file(line,col)" style references from a line.
function extractFileRefs(lines: string[]): string[] {
  const refs = new Set<string>();
  const patterns = [
    // ./app/page.tsx:12:5  or  app/page.tsx:12
    /(?:\.\/)?([\w./-]+\.(?:tsx?|jsx?|mjs|cjs|css|json)):(\d+)(?::\d+)?/g,
    // app/page.tsx(12,5)
    /([\w./-]+\.(?:tsx?|jsx?)):?\((\d+),\d+\)/g,
  ];
  for (const line of lines) {
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) {
        refs.add(`${m[1]}:${m[2]}`);
      }
    }
  }
  return Array.from(refs).slice(0, 10);
}

function linesMatching(lines: string[], re: RegExp): string[] {
  return lines.filter((l) => re.test(l)).map((l) => l.trim()).slice(0, 6);
}

const MATCHERS: Matcher[] = [
  // Missing module / dependency not installed.
  {
    match(lines) {
      const re = /(Cannot find module|Module not found|Can't resolve|ERR_MODULE_NOT_FOUND)/i;
      const hits = linesMatching(lines, re);
      if (hits.length === 0) return null;
      const isNextMissing = lines.some((l) => /Cannot find module 'next'|'next' is not/i.test(l));
      return {
        likely_cause: isNextMissing
          ? 'Dependencies are not installed (the `next` package is missing).'
          : 'A module could not be resolved — a dependency is missing or an import path is wrong.',
        evidence: hits,
        file_refs: extractFileRefs(lines),
        suggested_actions: isNextMissing
          ? ['forge install --app <app>', 'forge build --app <app>']
          : [
              'Check the import path in the referenced file.',
              'If it is a package, add it and run: forge install --app <app>',
            ],
      };
    },
  },
  // TypeScript type errors.
  {
    match(lines) {
      const re = /(error TS\d+|Type error:|has no exported member|is not assignable to type)/;
      const hits = linesMatching(lines, re);
      if (hits.length === 0) return null;
      return {
        likely_cause: 'TypeScript type error(s) prevented the build from completing.',
        evidence: hits,
        file_refs: extractFileRefs(lines),
        suggested_actions: [
          'Fix the type error(s) in the referenced file(s).',
          'Re-run: forge build --app <app>',
        ],
      };
    },
  },
  // ESLint problems.
  {
    match(lines) {
      const re = /(\d+ problems? \(\d+ errors?)|(Error:.*eslint)|(@typescript-eslint\/)|(react\/)/;
      const hits = linesMatching(lines, re);
      const problemLine = lines.find((l) => /\d+ problems? \(\d+ error/.test(l));
      if (hits.length === 0 && !problemLine) return null;
      return {
        likely_cause: 'Lint reported problems that must be resolved.',
        evidence: [problemLine?.trim(), ...hits].filter(Boolean).slice(0, 6) as string[],
        file_refs: extractFileRefs(lines),
        suggested_actions: [
          'Address the lint errors in the referenced file(s).',
          'Re-run: forge lint --app <app>',
        ],
      };
    },
  },
  // Test failures.
  {
    match(lines) {
      const re = /(FAIL |✗|× |AssertionError|Expected:|Received:|Test Files\s+\d+ failed)/;
      const hits = linesMatching(lines, re);
      if (hits.length === 0) return null;
      return {
        likely_cause: 'One or more tests failed.',
        evidence: hits,
        file_refs: extractFileRefs(lines),
        suggested_actions: [
          'Inspect the failing assertion and fix the code or the test.',
          'Re-run: forge test --app <app>',
        ],
      };
    },
  },
  // Next.js build-time prerender error (commonly NODE_ENV=development during
  // `next build`, or importing next/document from the App Router).
  {
    match(lines) {
      const re = /(should not be imported outside of pages\/_document|Error occurred prerendering|no-document-import-in-page)/;
      const hits = linesMatching(lines, re);
      if (hits.length === 0) return null;
      return {
        likely_cause:
          'A build-time prerender error occurred — most often `next build` ran with NODE_ENV=development, or next/document was imported from the App Router.',
        evidence: hits,
        file_refs: extractFileRefs(lines),
        suggested_actions: [
          'Ensure the Build runs with production NODE_ENV (do not force NODE_ENV=development).',
          'Re-run: forge build --app <app>',
        ],
      };
    },
  },
  // Syntax errors.
  {
    match(lines) {
      const re = /(SyntaxError|Unexpected token|Parsing error|Unexpected end of)/;
      const hits = linesMatching(lines, re);
      if (hits.length === 0) return null;
      return {
        likely_cause: 'A syntax/parse error was encountered.',
        evidence: hits,
        file_refs: extractFileRefs(lines),
        suggested_actions: ['Fix the syntax error in the referenced file.'],
      };
    },
  },
  // Port already in use.
  {
    match(lines) {
      const re = /(EADDRINUSE|address already in use|port is already allocated)/i;
      const hits = linesMatching(lines, re);
      if (hits.length === 0) return null;
      return {
        likely_cause: 'A required port is already in use.',
        evidence: hits,
        file_refs: [],
        suggested_actions: [
          'Stop the process/container using the port, or reprovision with a different port.',
        ],
      };
    },
  },
];

export function analyzeLines(lines: string[]): Diagnosis {
  for (const matcher of MATCHERS) {
    const d = matcher.match(lines);
    if (d) return d;
  }
  // Fallback: return a NOISE-FILTERED tail as evidence with a generic cause.
  const noise = /^(npm notice|npm warn|npm WARN|Attention:|You can learn more|This information|https?:\/\/|>\s|\$\s|\s*$)/;
  const meaningful = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !noise.test(l) && !/^at\s/.test(l));
  const tail = (meaningful.length ? meaningful : lines.map((l) => l.trim()).filter(Boolean)).slice(-12);
  return {
    likely_cause: 'The command failed but no known error signature matched. See the evidence tail.',
    evidence: tail.slice(-6),
    file_refs: extractFileRefs(tail),
    suggested_actions: ['Review the full log: forge logs <resource-id> --full'],
  };
}

export async function analyzeLogFile(logFile: string): Promise<Diagnosis> {
  let raw = '';
  try {
    raw = await readFile(logFile, 'utf8');
  } catch {
    return {
      likely_cause: 'Log file could not be read.',
      evidence: [],
      file_refs: [],
      suggested_actions: ['Ensure the resource id is correct.'],
    };
  }
  const lines = raw.split('\n');
  return analyzeLines(lines);
}
