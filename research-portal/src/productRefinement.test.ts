import { describe, expect, it } from "vitest";
import { portalBasePath, parsePortalRoute, portalRouteSearch } from "./portalRoute";
import { portalExperimentById, type PortalExperiment } from "./experimentRegistry";
import { experimentBriefHtml, experimentReadingsCsv, reportReadings, type ExperimentReportInput } from "./experimentReport";
import { latestQualityIssues, vwcQuality } from "./readingQuality";
import type { SensorReading } from "./types";

const day=86_400_000;
const end=Date.parse("2026-10-05T00:00:00Z");
const experiment:PortalExperiment={id:"completed",name:"<Trial & review>",shortDescription:"<script>alert(1)</script>",mode:"observation",status:"completed",wateringState:"off",groupNames:[],pairingNames:["Pot1"],startedAt:new Date(end-day).toISOString(),endedAt:new Date(end).toISOString(),assignments:[{pot_id:null,pairing_name:"Pot1",zone:1,pot_number:1,crop:"sorghum",treatment:"observation",block:null,substrate:null,target_vwc_percent:null,measurement_interval_minutes:10}]};
const reading=(at:number,name="Pot1",value=-1.2):SensorReading=>({id:at,event_id:`event:${at}`,pairing_name:name,sensor_key:"sensor:1",raw_value:1200,calibrated_value:value,temperature:22,electrical_conductivity:null,device_recorded_at:new Date(at).toISOString(),server_received_at:new Date(at+1000).toISOString()});
const input:ExperimentReportInput={experiment,pairings:[],readings:[reading(end-day-1),reading(end-day),reading(end-1),reading(end),reading(end-1000,"Other")],events:[],problems:[],startMs:end-day,endMs:end,generatedAt:end+day,source:"Stored readings"};

describe("assembled public route contexts",()=>{
 it("keeps sample links and copied routes in the demo on the production hostname",()=>{
  for(const host of ["exacth2o.com","www.exacth2o.com","127.0.0.1"]){
   for(const path of ["/demo","/demo.html","/demo/"])expect(portalBasePath(path,host)).toBe("/demo");
  }
  const route=parsePortalRoute("?experiment=experiment-1&pot=Pot1");
  expect(parsePortalRoute(portalRouteSearch(route))).toEqual(route);
  expect(portalBasePath("/applications-demo-app/index.html","exacth2o.com")).toBe("/applications-demo-app/index.html");
  expect(portalBasePath("/portal.html","exacth2o.com")).toBe("/portal");
 });
 it("does not silently select a different experiment for global settings",()=>{
  expect(portalExperimentById("",[experiment]).id).toBe("unavailable");
  expect(portalExperimentById("missing",[experiment]).id).toBe("unavailable");
  expect(portalExperimentById("completed",[experiment])).toBe(experiment);
 });
});
describe("experiment exports",()=>{
 it("limits completed exports to their own pots and lifetime, with an exclusive end",()=>{
  expect(reportReadings(input).map(r=>r.id)).toEqual([end-day,end-1]);
 });
 it("retains implausible measurements and consistent factors in the CSV",()=>{
  const csv=experimentReadingsCsv(input);
  expect(csv).toContain("sorghum,observation");expect(csv).toContain(",-1.2,1200,22,");
  expect(csv).toContain("plan_snapshot_revision");expect(csv).not.toContain("Other");
 });
 it("escapes report markup and spreadsheet formulas without hiding numeric negatives",()=>{
  const brief=experimentBriefHtml(input);expect(brief).not.toContain("<script>");expect(brief).toContain("&lt;script&gt;");
  const csv=experimentReadingsCsv({...input,experiment:{...experiment,name:"=SUM(1,1)"}});
  expect(csv).toContain("'=SUM(1,1)");expect(csv).toContain(",-1.2,");
 });
 it("states unavailable sources, reporting scope and historical plan boundaries",()=>{
  const brief=experimentBriefHtml({...input,problems:["Notes unavailable"]});
  expect(brief).toContain("Notes unavailable");expect(brief).toContain("UTC");expect(brief).toContain("not necessarily the complete experiment");expect(brief).toContain("do not establish the controller target or calibration");
 });
});
describe("measurement quality",()=>{
 it("flags range problems independently of freshness while preserving valid extremes",()=>{
  expect(vwcQuality(-1.2)).toBeTruthy();expect(vwcQuality(101)).toBeTruthy();expect(vwcQuality(0)).toBeNull();expect(vwcQuality(100)).toBeNull();expect(vwcQuality(null)).toBeNull();
 });
 it("clears a pot's quality exception when its latest reading is plausible",()=>{
  expect(latestQualityIssues([reading(end-10),reading(end,"Pot1",20)]).length).toBe(0);
 });
});
