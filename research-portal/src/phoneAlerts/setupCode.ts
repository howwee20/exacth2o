export async function phoneSetupCode(projectId: string | null, view: "account" | "new-experiment") {
  const url = new URL("/portal", location.origin);
  url.searchParams.set("view", view);
  if (projectId) url.searchParams.set("project", projectId);
  url.searchParams.set("phoneSetup", "1");
  if (view === "account") url.hash = "phone-alerts";
  const { toDataURL } = await import("qrcode");
  return toDataURL(url.href, { width: 176, margin: 4 });
}
