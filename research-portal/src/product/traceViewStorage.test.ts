import { describe, expect, it } from 'vitest';
import { captureTraceRange, readTraceViews, restoreTraceView } from './traceViewStorage';
const view = { id:'one', name:'Control comparison', pairingNames:['Pot 1','Pot 2'], range:{startMs:2000,endMs:8000} };
describe('saved comparisons', () => {
  it('restores absolute dates when the loaded window moves', () => {
    expect(captureTraceRange({startMs:0,endMs:10000},{start:20,end:80})).toEqual(view.range);
    expect(restoreTraceView(view,['Pot 1','Pot 2'],{startMs:1000,endMs:11000}).window).toEqual({start:10,end:70});
  });
  it('does not silently substitute a different date range or different pots', () => {
    expect(restoreTraceView(view,['Pot 1'],{startMs:5000,endMs:15000}).error).toContain('outside');
    expect(restoreTraceView(view,['Pot 3'],{startMs:0,endMs:10000}).error).toContain('no longer');
    expect(restoreTraceView(view,['Pot 1'],{startMs:0,endMs:10000}).warning).toContain('Some pots');
  });
  it('ignores corrupt storage and invalid or unbounded records', () => {
    expect(readTraceViews('{')).toEqual([]);
    expect(readTraceViews(JSON.stringify([view,{...view,range:{startMs:9,endMs:1}},{...view,pairingNames:[42]}]))).toEqual([view]);
    expect(readTraceViews(JSON.stringify(Array(30).fill(view)))).toHaveLength(12);
  });
  it('restores a demo replay window after its displayed clock shifts', () => {
    expect(restoreTraceView({...view,range:null,replayWindow:{start:10,end:65}},['Pot 1','Pot 2'],{startMs:100000,endMs:110000}).window).toEqual({start:10,end:65});
  });
  it('suggested comparisons use the currently loaded range', () => {
    expect(restoreTraceView({...view,range:null},['Pot 1','Pot 2'],{startMs:0,endMs:10000}).window).toEqual({start:0,end:100});
  });
});
