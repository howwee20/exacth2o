import { supabase } from './supabase';
export async function readDirectCommands(projectId:string,ids:string[]) {
 const {data,error}=await supabase.from('project_control_commands').select('id,status').eq('project_id',projectId).in('id',ids);
 if(error)throw error;return data ?? [];
}
