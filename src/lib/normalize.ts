const TRACKING_PARAM = /^utm_/;

function isTrackingParam(key: string): boolean {
  return TRACKING_PARAM.test(key) || key === "fbclid" || key === "gclid";
}

function defaultNormalize(url: URL): string {
  const params = [...url.searchParams].filter(([key]) => !isTrackingParam(key));
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const search = new URLSearchParams(params).toString();

  let pathname = url.pathname;
  if (pathname === "/") pathname = "";
  else if (pathname.endsWith("/")) pathname = pathname.slice(0, -1);

  return `${url.protocol}//${url.host}${pathname}${search ? `?${search}` : ""}`;
}

export interface SiteRule {
  match(url: URL): boolean;
  normalize(url: URL): string;
}

const GITHUB_ISSUE_OR_PR = /^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)(?:\/.*)?$/;

const githubRule: SiteRule = {
  match(url) {
    return url.hostname === "github.com" && GITHUB_ISSUE_OR_PR.test(url.pathname);
  },
  normalize(url) {
    const match = GITHUB_ISSUE_OR_PR.exec(url.pathname) as RegExpExecArray;
    const [, owner, repo, kind, number] = match;
    return `https://github.com/${owner}/${repo}/${kind}/${number}`;
  },
};

export const SITE_RULES: SiteRule[] = [githubRule];

export function normalize(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }

  for (const rule of SITE_RULES) {
    if (rule.match(url)) return rule.normalize(url);
  }
  return defaultNormalize(url);
}
