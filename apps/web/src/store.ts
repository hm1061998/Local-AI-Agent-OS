import { create } from 'zustand';
import type { AgentEvent, TaskRecord } from '@local-agent/agent-protocol';
interface Store {
  active?: TaskRecord;
  events: AgentEvent[];
  stream: string;
  setActive: (task: TaskRecord) => void;
  addEvent: (event: AgentEvent) => void;
  setEvents: (events: AgentEvent[]) => void;
}
export const useAgentStore = create<Store>((set) => ({
  events: [],
  stream: '',
  setActive: (active) =>
    set((state) =>
      state.active?.id === active.id ? { active } : { active, events: [], stream: '' },
    ),
  addEvent: (event) =>
    set((s) => ({
      events: s.events.some((e) => e.id === event.id) ? s.events : [...s.events, event],
      stream: event.message,
    })),
  setEvents: (events) => set({ events }),
}));
