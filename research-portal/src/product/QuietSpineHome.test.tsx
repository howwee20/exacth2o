import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuietSpineHome } from "./QuietSpineHome";

describe("new installation home", () => {
  it("keeps system actions visible before the first experiment or observation", () => {
    const html = renderToStaticMarkup(<QuietSpineHome
      experiments={[]} exceptions={[]} nowMs={0} checking={false} catalogError={null}
      installation={{ status: "unknown", message: "Awaiting first connection" }}
      canCreate={false} onNewExperiment={() => {}} onEditExperiment={() => {}}
      healthLink={<a href="/portal?project=testbed&amp;view=autocalibrate">Autocalibrate</a>}
      recordAvailable systemName="Four-pot calibration testbed"
    />);
    expect(html).toContain("Four-pot calibration testbed");
    expect(html).toContain("Awaiting first connection");
    expect(html).toContain("Autocalibrate");
    expect(html).not.toContain("Online");
  });
});
