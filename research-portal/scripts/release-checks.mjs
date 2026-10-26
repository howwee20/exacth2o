// The small, explicit UI release gate. The complete suites remain available separately.
export const unitChecks = [
  { file: 'src/experimentTraceReadings.test.ts', name: 'keeps the experiment boundary and follows a renamed sensor' },
  { file: 'src/experimentExportClient.test.ts', name: 'crosses the former 50,000-row cutoff, including equal timestamps' },
  { file: 'src/seriesStatistics.test.ts', name: 'excludes invalid values instead of treating them as zero' },
  { file: 'src/product/directExperimentModel.test.ts', name: 'changes only the explicit scope and preserves live settings for all other pots' },
  { file: 'src/holdSession.test.ts', name: 'release stops at once and reports the measured release-to-close time once the controller confirms' },
  { file: 'src/product/directExperimentModel.test.ts', name: 'requires every command acknowledgement before reporting applied' },
];
export const policyCheck = 'viewers and unknown roles cannot submit controller commands';
export const browserChecks = [
  'Control requires confirmation after the checkmark',
  'Drought requires confirmation after the checkmark',
  'assembled demo has one quiet graph, with Groups sharing the time range and Record under More',
];
export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
