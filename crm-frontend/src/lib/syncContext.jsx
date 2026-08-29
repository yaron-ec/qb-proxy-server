/**
 * Global Sync Context — non-blocking background sync tracking.
 * All sync operations register here; UI reads from here.
 * Does NOT block navigation or any app functionality.
 */
import { createContext, useContext, useState, useCallback, useRef } from "react";

const SyncContext = createContext(null);

// Job status: queued | running | completed | failed | retrying
let jobIdCounter = 0;

export function SyncProvider({ children }) {
  const [jobs, setJobs] = useState([]); // { id, label, integration, status, progress, error, startedAt, completedAt }
  const jobsRef = useRef([]);

  const updateJob = useCallback((id, patch) => {
    setJobs(prev => {
      const next = prev.map(j => j.id === id ? { ...j, ...patch } : j);
      jobsRef.current = next;
      return next;
    });
  }, []);

  /** Register a new sync job. Returns jobId. */
  const addJob = useCallback((label, integration) => {
    const id = ++jobIdCounter;
    const job = { id, label, integration, status: 'queued', progress: null, error: null, startedAt: new Date().toISOString(), completedAt: null };
    setJobs(prev => {
      const next = [...prev.slice(-19), job]; // keep last 20
      jobsRef.current = next;
      return next;
    });
    return id;
  }, []);

  const startJob = useCallback((id) => updateJob(id, { status: 'running' }), [updateJob]);
  const progressJob = useCallback((id, progress) => updateJob(id, { progress }), [updateJob]);
  const retryJob = useCallback((id) => updateJob(id, { status: 'retrying' }), [updateJob]);
  const completeJob = useCallback((id, extra = {}) => updateJob(id, { status: 'completed', completedAt: new Date().toISOString(), ...extra }), [updateJob]);
  const failJob = useCallback((id, error) => updateJob(id, { status: 'failed', error, completedAt: new Date().toISOString() }), [updateJob]);

  /** Check if a given integration already has a running/queued job (duplicate prevention). */
  const isRunning = useCallback((integration) => {
    return jobsRef.current.some(j => j.integration === integration && (j.status === 'running' || j.status === 'queued' || j.status === 'retrying'));
  }, []);

  const clearCompleted = useCallback(() => {
    setJobs(prev => {
      const next = prev.filter(j => j.status !== 'completed');
      jobsRef.current = next;
      return next;
    });
  }, []);

  const activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'queued' || j.status === 'retrying');
  const hasActive = activeJobs.length > 0;
  const recentJobs = jobs;

  return (
    <SyncContext.Provider value={{ jobs: recentJobs, activeJobs, hasActive, addJob, startJob, progressJob, retryJob, completeJob, failJob, isRunning, clearCompleted }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within SyncProvider');
  return ctx;
}