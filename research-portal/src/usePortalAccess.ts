import type * as React from "react";
import { useCallback,useState } from "react";
import {
isSessionAuthorizationError
} from "./authSession";
import { type PortalExperiment } from "./experimentRegistry";
import { parsePortalRole } from "./portalAccess";
import { portalAccessTimeoutMs } from "./portalConstants";
import { selectPortalAccessRow,selectProjectDevice } from "./portalProjectContext";
import { type PortalAccess } from "./portalTypes";
import { supabase } from "./supabase";
import { withSupabaseTimeout } from "./supabaseTimeout";



/** PortalAccess owns this workspace behavior; App supplies the current scope. */
type Context = {
  setAccessLoading: React.Dispatch<React.SetStateAction<boolean>>;
  recoverPortalSession: () => Promise<boolean>;
  setPortalAccess: React.Dispatch<React.SetStateAction<PortalAccess>>;
  expirePortalSession: () => void;
  setExperimentCatalog: React.Dispatch<React.SetStateAction<PortalExperiment[]>>;
  setExperimentBuilderOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingExperiment: React.Dispatch<React.SetStateAction<PortalExperiment | null>>;
  setExperimentCatalogError: React.Dispatch<React.SetStateAction<string | null>>;
};

export function usePortalAccess({ setAccessLoading, recoverPortalSession, setPortalAccess, expirePortalSession, setExperimentCatalog, setExperimentBuilderOpen, setEditingExperiment, setExperimentCatalogError }: Context) {
  const [accessCheckError, setAccessCheckError] = useState<string | null>(null);

  const loadPortalAccess = useCallback(async () => {
    setAccessCheckError(null);
    setAccessLoading(true);
    try {
      const queryAccess = async () => {
        const userResponse = await withSupabaseTimeout(
          supabase.auth.getUser(),
          portalAccessTimeoutMs,
          "Portal session",
        );
        if (userResponse.error) throw userResponse.error;
        const userId = userResponse.data.user?.id ?? null;
        if (!userId) throw { status: 401, message: "Portal session is unavailable" };

        const accessResponse = await withSupabaseTimeout(
          supabase
            .from("portal_access")
            .select("project_id, role, email, created_at, access_scope")
            .eq("user_id", userId)
            .order("created_at", { ascending: true })
            .limit(20),
          portalAccessTimeoutMs,
          "Portal access",
        );
        if (accessResponse.error) throw accessResponse.error;
        const requestedProjectId = new URLSearchParams(window.location.search).get("project");
        const accessRow = selectPortalAccessRow(
          accessResponse.data ?? [],
          requestedProjectId,
        );
        if (!accessRow) return { data: null };
        const signedInUserId = userId;

        const mixerAccess = await withSupabaseTimeout(
          supabase.rpc("has_gas_mixer_native_access", {
            check_project_id: "44444444-4444-4444-8444-444444444441",
            check_device_id: "gas-mixer:b827eb548a44",
            check_capability: "remote_view",
          }), portalAccessTimeoutMs, "Gas mixer access",
        ).catch(() => null);
        const gas_mixer_allowed = mixerAccess?.error == null && mixerAccess?.data === true;
        // A failed capability check hides only the inbox; research access remains usable.
        const supportAccess = accessRow.role === "admin" ? await withSupabaseTimeout(
          supabase.rpc("is_sales_support_staff", { check_project_id: accessRow.project_id }),
          portalAccessTimeoutMs, "Sales & Support access",
        ).catch(() => null) : null;
        const sales_support_allowed = supportAccess?.error == null && supportAccess?.data === true;
        if (accessRow.access_scope !== "project") {
          return { data: { ...accessRow, device_id: null, gas_mixer_allowed, sales_support_allowed, user_id: signedInUserId } };
        }

        const deviceResponse = await withSupabaseTimeout(
          supabase
            .from("device_config_state")
            .select("device_id, updated_at")
            .eq("project_id", accessRow.project_id)
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          portalAccessTimeoutMs,
          "Project device",
        );
        if (deviceResponse.error) throw deviceResponse.error;
        return {
          data: {
            ...accessRow,
            gas_mixer_allowed,
            sales_support_allowed,
            user_id: signedInUserId,
            device_id: selectProjectDevice(deviceResponse.data ? [deviceResponse.data] : []),
          },
        };
      };

      let response;
      try {
        response = await queryAccess();
      } catch (err) {
        if (!isSessionAuthorizationError(err) || !(await recoverPortalSession())) throw err;
        response = await queryAccess();
      }

      const role = parsePortalRole(response.data?.role);
      if (!role) {
        setPortalAccess(null);
        return;
      }
      const access: Exclude<PortalAccess, null> = {
        role,
        userId: response.data?.user_id ?? undefined,
        email: response.data?.email ?? null,
        projectId: response.data?.project_id ?? "",
        deviceId: response.data?.device_id ?? null,
        accessScope: response.data?.access_scope ?? "none",
        gasMixerAllowed: response.data?.gas_mixer_allowed === true,
        salesSupportAllowed: response.data?.sales_support_allowed === true,
      };
      if (!access.projectId) {
        setPortalAccess(null);
        return;
      }
      setPortalAccess(access);
    } catch (err) {
      if (isSessionAuthorizationError(err)) {
        expirePortalSession();
        return;
      }
      setAccessCheckError("We could not check your portal access. Please retry.");
      setPortalAccess(null);
      setExperimentCatalog([]);
      setExperimentBuilderOpen(false);
      setEditingExperiment(null);
      setExperimentCatalogError(null);
    } finally {
      setAccessLoading(false);
    }
  }, [expirePortalSession, recoverPortalSession, setAccessLoading, setEditingExperiment, setExperimentBuilderOpen, setExperimentCatalog, setExperimentCatalogError, setPortalAccess]);

  return { accessCheckError, loadPortalAccess };
}
