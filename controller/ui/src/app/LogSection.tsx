import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { Log } from "./lib/types";
import { useErrorLogs, useRegularLogs } from "./swr/useLogs";

/**
 * Accordion component for displaying logs
 */
function LogAccordion({
  title,
  logs,
  isOpen,
  onToggle,
  isLoading
}: {
  title: string;
  logs: Log[];
  isOpen: boolean;
  onToggle: () => void;
  isLoading: boolean;
}) {
  return (
    <div className="bg-white rounded-lg border shadow-sm h-fit">
      <div
        className="p-6 flex flex-row items-center justify-between border-b cursor-pointer"
        onClick={onToggle}
      >
        <h3 className="text-lg font-semibold">{title}</h3>
        {isOpen ? (
          <ChevronUpIcon className="h-5 w-5" />
        ) : (
          <ChevronDownIcon className="h-5 w-5" />
        )}
      </div>

      {isOpen && (
        <div className="p-6">
          <div className="overflow-x-auto rounded-md border max-h-96 overflow-y-auto">
            <table className="w-full">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Time</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Level</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Message</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-3 text-center text-gray-500">Loading logs...</td>
                  </tr>
                ) : logs?.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-3 text-center text-gray-500">No logs found</td>
                  </tr>
                ) : (
                  logs?.map((log) => (
                    <tr key={log.id} className="border-t">
                      <td className="px-4 py-3 whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td className={`px-4 py-3 ${
                        log.level === 'error' ? 'text-red-600' :
                        log.level === 'warn' ? 'text-yellow-600' :
                        log.level === 'info' ? 'text-blue-600' : 'text-gray-600'
                      }`}>
                        {log.level}
                      </td>
                      <td className="px-4 py-3">{log.message}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}



export function LogSection({ refreshIntervalMs = 5000 }: { refreshIntervalMs?: number }) {
  // State for log accordions
  const [isLogsOpen, setIsLogsOpen] = useState(false)
  const [isErrorsOpen, setIsErrorsOpen] = useState(false)

  // SWR hooks for server-side filtered logs
  const { logs: regularLogs, isLoading: regularLogsLoading } = useRegularLogs(100, refreshIntervalMs)
  const { logs: errorLogs, isLoading: errorLogsLoading } = useErrorLogs(100, refreshIntervalMs)

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      {/* Regular Logs */}
      <LogAccordion
        title="Logs"
        logs={regularLogs || []}
        isOpen={isLogsOpen}
        onToggle={() => setIsLogsOpen(!isLogsOpen)}
        isLoading={regularLogsLoading}
      />

      {/* Error Logs */}
      <LogAccordion
        title="Errors"
        logs={errorLogs || []}
        isOpen={isErrorsOpen}
        onToggle={() => setIsErrorsOpen(!isErrorsOpen)}
        isLoading={errorLogsLoading}
      />
    </div>
  )
}