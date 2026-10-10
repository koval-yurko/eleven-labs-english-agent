/**
 * Re-emit a services/api response from one of tutor-web's same-origin routes: status and JSON body
 * unchanged, and only the content type copied — never upstream hop-by-hop or caching headers.
 */
export function forward(res: Response): Response {
  return new Response(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
