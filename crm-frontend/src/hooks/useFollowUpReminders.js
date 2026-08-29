/**
 * useFollowUpReminders
 *
 * Polls every 60s for follow-ups that are due NOW (within ±5 min window).
 * Returns a queue of reminders to show. Skips snoozed / done items.
 * Scoped to the current user (or all leads for admin).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/lib/AuthContext';
import * as railwayLeads from '@/api/railway/leads';

const STORAGE_KEY = 'crm_fu_reminders';
const POLL_MS = 60_000;       // check every 60s
const WINDOW_MS = 5 * 60_000; // show reminder if within ±5 min of follow_up time

const USER_OWNER_MAP = {
  'yaron@ecconstructiongroup.com': 'Yaron Drilevich',
  'yaron.ecrenewables@gmail.com': 'Yaron Drilevich',
  'ethan@ecconstructiongroup.com': 'Ethan Magen',
  'micky@ecconstructiongroup.com': 'Micky Gad',
  'michelle@ecconstructiongroup.com': 'Michelle Roitman Drilevich',
  'matt@ecconstructiongroup.com': 'Matt Aharoni',
  'karen@ecconstructiongroup.com': 'Karen Hirschorn',
  'michelle.roitman@ecconstructiongroup.com': 'Michelle Roitman Drilevich',
};

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveState(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

/** Parse "YYYY-MM-DD" + "HH:MM" into a local-time epoch ms */
function parseFollowUpMs(date, time) {
  if (!date || !time) return null;
  const m = String(date).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, yr, mo, dy] = m.map(Number);
  const [hh, mm] = String(time).split(':').map(Number);
  return new Date(yr, mo - 1, dy, hh, mm || 0, 0).getTime();
}

export function useFollowUpReminders() {
  const { user } = useAuth();
  const [queue, setQueue] = useState([]);
  const stateRef = useRef(loadState());
  const userRef = useRef(null);

  // Keep userRef in sync with auth context
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Request browser notification permission once
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  const checkReminders = useCallback(async () => {
    const user = userRef.current;
    if (!user) return;

    const isAdmin = user.role === 'admin' || user.role === 'manager';
    const myName = USER_OWNER_MAP[user.email] || user.full_name;
    const now = Date.now();

    let leads;
    try {
      const res = await railwayLeads.list({ limit: 2000 });
      leads = res.items || [];
    } catch {
      return;
    }

    const state = stateRef.current;
    const newReminders = [];

    for (const lead of leads) {
      if (!lead.follow_up_date || !lead.follow_up_time) continue;
      if (!lead.follow_up_type) continue;
      // skip Sold/DNQ/Lost
      if (['Sold', 'DNQ', 'Lost'].includes(lead.status)) continue;

      // scope to current user unless admin
      if (!isAdmin) {
        const rep = (lead.assigned_rep || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const mine = myName.trim().toLowerCase().replace(/\s+/g, ' ');
        if (rep !== mine) continue;
      }

      const fuMs = parseFollowUpMs(lead.follow_up_date, lead.follow_up_time);
      if (!fuMs) continue;

      // Key: leadId + date + time — unique per follow-up event
      const key = `${lead.id}:${lead.follow_up_date}:${lead.follow_up_time}`;

      // Skip if marked done
      if (state[key]?.done) continue;

      // Skip if snoozed and snooze hasn't expired yet
      if (state[key]?.snoozedUntil && now < state[key].snoozedUntil) continue;

      // Show if within the ±5 min window (or up to 10 min past — in case tab was inactive)
      const diff = now - fuMs;
      if (diff < -WINDOW_MS || diff > 10 * 60_000) continue;

      newReminders.push({
        key,
        lead,
        fuMs,
        type: lead.follow_up_type, // 'Phone Call' | 'Meeting'
      });
    }

    // Only update state if something changed (avoid re-renders)
    setQueue(prev => {
      const prevKeys = prev.map(r => r.key).join(',');
      const nextKeys = newReminders.map(r => r.key).join(',');
      if (prevKeys === nextKeys) return prev;
      return newReminders;
    });

    // Fire browser notification for new items
    if ('Notification' in window && Notification.permission === 'granted') {
      for (const r of newReminders) {
        const prevState = stateRef.current[r.key];
        if (!prevState?.notified) {
          const label = r.type === 'Phone Call' ? '📞 Call' : '📅 Meeting';
          new Notification(`${label}: ${r.lead.first_name} ${r.lead.last_name}`, {
            body: `Follow-up now · ${r.lead.phone || 'No phone'}`,
            icon: '/favicon.ico',
          });
          stateRef.current = { ...stateRef.current, [r.key]: { ...prevState, notified: true } };
          saveState(stateRef.current);
        }
      }
    }
  }, []);

  // Start polling when user is available
  useEffect(() => {
    if (!user) return;
    let timer;
    checkReminders();
    timer = setInterval(checkReminders, POLL_MS);
    return () => clearInterval(timer);
  }, [user, checkReminders]);

  const snooze = useCallback((key, minutes) => {
    const until = Date.now() + minutes * 60_000;
    stateRef.current = { ...stateRef.current, [key]: { ...stateRef.current[key], snoozedUntil: until, notified: false } };
    saveState(stateRef.current);
    setQueue(q => q.filter(r => r.key !== key));
  }, []);

  const markDone = useCallback((key, leadId, followUpDate, followUpTime) => {
    stateRef.current = { ...stateRef.current, [key]: { done: true } };
    saveState(stateRef.current);
    setQueue(q => q.filter(r => r.key !== key));
    // Clear the follow-up from the lead
    railwayLeads.update(leadId, {
      follow_up_date: null,
      follow_up_time: null,
      follow_up_type: null,
    }).catch(() => {});
  }, []);

  const dismiss = useCallback((key) => {
    // Snooze 5 min silently (don't clear the lead)
    snooze(key, 5);
  }, [snooze]);

  return { queue, snooze, markDone, dismiss };
}