import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { Link } from "react-router-dom";
import { Plus, Search, Filter, DollarSign, Users, CheckCircle2, AlertCircle, TrendingUp } from "lucide-react";

const PROJECT_STATUS_COLORS = {
  'Pre-Construction': 'bg-blue-100 text-blue-700',
  'In Progress': 'bg-orange-100 text-orange-700',
  'On Hold': 'bg-amber-100 text-amber-700',
  'Completed': 'bg-emerald-100 text-emerald-700',
  'Cancelled': 'bg-red-100 text-red-700',
};

export default function ProjectsModern() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    loadProjects();
    const interval = setInterval(loadProjects, 30000);
    return () => clearInterval(interval);
  }, []);

  const loadProjects = async () => {
    try {
      const res = await apiCall('/api/v1/deals?limit=500', { method: 'GET' });
      const allProjects = Array.isArray(res) ? res : (res?.items || []);
      setProjects(allProjects);
      setLoading(false);
    } catch (e) {
      console.error('Error loading projects:', e);
      setLoading(false);
    }
  };

  const filteredProjects = projects
    .filter(p => {
      const text = `${p.name} ${p.client_name} ${p.property_address || ''}`.toLowerCase();
      return text.includes(searchTerm.toLowerCase());
    })
    .filter(p => statusFilter === 'all' || p.status === statusFilter);

  const getProgressPercent = (project) => {
    if (project.status === 'Completed') return 100;
    if (project.status === 'Pre-Construction') return 0;
    if (project.status === 'On Hold') return 50;
    return 65;
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-3xl font-bold text-slate-900">Projects</h1>
              <p className="text-sm text-slate-500 mt-1">{filteredProjects.length} projects</p>
            </div>
            <button className="flex items-center gap-2 bg-gradient-to-r from-slate-900 to-slate-800 text-white px-4 py-2 rounded-xl font-semibold hover:shadow-lg transition-all duration-200 active:scale-95">
              <Plus className="w-4 h-4" />
              New Project
            </button>
          </div>

          {/* Filters */}
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search projects..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 transition-all"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-4 py-2 border border-slate-200 rounded-xl text-sm font-medium bg-white focus:outline-none focus:ring-2 focus:ring-slate-900/10 transition-all"
            >
              <option value="all">All Statuses</option>
              {Object.keys(PROJECT_STATUS_COLORS).map(status => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Projects Grid */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <span className="text-slate-500">Loading projects...</span>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-slate-500">No projects found</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredProjects.map(project => {
              const progress = getProgressPercent(project);
              return (
                <Link
                  key={project.id}
                  to={`/projects/${project.id}`}
                  className="card-premium p-6 group hover:shadow-lg transition-all duration-200 cursor-pointer flex flex-col"
                >
                  {/* Header */}
                  <div className="mb-4">
                    <h3 className="font-semibold text-slate-900 mb-1 group-hover:text-slate-700 transition-colors">
                      {project.name}
                    </h3>
                    <p className="text-sm text-slate-600">{project.client_name}</p>
                  </div>

                  {/* Status */}
                  <div className="mb-4">
                    <span className={`text-xs font-semibold px-3 py-1 rounded-full ${PROJECT_STATUS_COLORS[project.status] || 'bg-slate-100 text-slate-700'}`}>
                      {project.status}
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-slate-600 font-medium">Progress</span>
                      <span className="text-xs text-slate-900 font-semibold">{progress}%</span>
                    </div>
                    <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-gradient-to-r from-slate-900 to-slate-700 transition-all duration-500"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-2 gap-3 pt-4 border-t border-slate-100">
                    <div>
                      <p className="text-xs text-slate-600 mb-1">Contract Value</p>
                      <p className="font-semibold text-slate-900">${(project.contract_value || 0).toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-600 mb-1">Start Date</p>
                      <p className="font-semibold text-slate-900">{project.start_date ? new Date(project.start_date).toLocaleDateString() : '—'}</p>
                    </div>
                  </div>

                  {/* Address */}
                  {project.property_address && (
                    <div className="mt-4 pt-4 border-t border-slate-100">
                      <p className="text-xs text-slate-600">📍 {project.property_address}</p>
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}