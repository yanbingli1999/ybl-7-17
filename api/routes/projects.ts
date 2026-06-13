import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createStore } from '../storage/fileStore.js';
import type {
  Project, Variable, ProjectWithVariables, CreateProjectDto, UpdateProjectDto,
  CreateVariableDto, ProjectExportData, SimulationResult, CompareRecord,
  ImportProjectDto, ImportResult, CheckNameResult,
} from '../../shared/types.js';

const router = Router();
const projectsStore = createStore<Project>('projects');
const variablesStore = createStore<Variable>('variables');
const simulationsStore = createStore<SimulationResult>('simulations');
const comparisonsStore = createStore<CompareRecord>('comparisons');

function getProjectWithVariables(projectId: string): ProjectWithVariables | null {
  const project = projectsStore.getById(projectId);
  if (!project) return null;
  const variables = variablesStore.filter(v => v.projectId === projectId);
  return { ...project, variables };
}

router.get('/', (_req: Request, res: Response) => {
  const projects = projectsStore.getAll();
  const projectsWithMeta = projects.map(p => {
    const variables = variablesStore.filter(v => v.projectId === p.id);
    const sims = simulationsStore.filter(s => s.projectId === p.id);
    const lastSim = sims.length > 0
      ? (sims[sims.length - 1] as unknown as { timestamp?: string })?.timestamp || null
      : null;
    return {
      ...p,
      variableCount: variables.length,
      simulationCount: sims.length,
      lastSimulationAt: lastSim,
    };
  });
  res.json(projectsWithMeta);
});

router.get('/:id', (req: Request, res: Response) => {
  const project = getProjectWithVariables(req.params.id);
  if (!project) {
    res.status(404).json({ error: '项目不存在' });
    return;
  }
  res.json(project);
});

router.post('/', (req: Request, res: Response) => {
  const dto = req.body as CreateProjectDto;
  if (!dto.name || dto.name.trim() === '') {
    res.status(400).json({ error: '项目名称不能为空' });
    return;
  }

  const now = new Date().toISOString();
  const project: Project = {
    id: uuidv4(),
    name: dto.name.trim(),
    description: dto.description?.trim() || '',
    createdAt: now,
    updatedAt: now,
  };

  const created = projectsStore.create(project);
  res.status(201).json(created);
});

router.put('/:id', (req: Request, res: Response) => {
  const dto = req.body as UpdateProjectDto;
  const existing = projectsStore.getById(req.params.id);
  if (!existing) {
    res.status(404).json({ error: '项目不存在' });
    return;
  }

  const updates: Partial<Project> = { updatedAt: new Date().toISOString() };
  if (dto.name !== undefined) {
    if (dto.name.trim() === '') {
      res.status(400).json({ error: '项目名称不能为空' });
      return;
    }
    updates.name = dto.name.trim();
  }
  if (dto.description !== undefined) {
    updates.description = dto.description.trim();
  }

  const updated = projectsStore.update(req.params.id, updates);
  res.json(updated);
});

router.delete('/:id', (req: Request, res: Response) => {
  const projectId = req.params.id;
  const existing = projectsStore.getById(projectId);
  if (!existing) {
    res.status(404).json({ error: '项目不存在' });
    return;
  }

  variablesStore.deleteMany(v => v.projectId === projectId);
  simulationsStore.deleteMany(s => s.projectId === projectId);
  comparisonsStore.deleteMany(c => c.projectId === projectId);
  projectsStore.delete(projectId);

  res.json({ success: true });
});

router.post('/:id/variables', (req: Request, res: Response) => {
  const projectId = req.params.id;
  const project = projectsStore.getById(projectId);
  if (!project) {
    res.status(404).json({ error: '项目不存在' });
    return;
  }

  const dto = req.body as CreateVariableDto;
  if (!dto.name || dto.name.trim() === '') {
    res.status(400).json({ error: '变量名称不能为空' });
    return;
  }
  if (dto.min >= dto.max) {
    res.status(400).json({ error: '最小值必须小于最大值' });
    return;
  }
  if (dto.mostLikely < dto.min || dto.mostLikely > dto.max) {
    res.status(400).json({ error: '最可能值必须在最小值和最大值之间' });
    return;
  }

  const variable: Variable = {
    id: uuidv4(),
    projectId,
    name: dto.name.trim(),
    type: dto.type || 'custom',
    min: Number(dto.min),
    max: Number(dto.max),
    mostLikely: Number(dto.mostLikely),
    weight: Number(dto.weight) ?? 1,
    unit: dto.unit?.trim() || '',
    createdAt: new Date().toISOString(),
  };

  projectsStore.update(projectId, { updatedAt: new Date().toISOString() });
  const created = variablesStore.create(variable);
  res.status(201).json(created);
});

router.get('/:id/export', (req: Request, res: Response) => {
  const projectId = req.params.id;
  const project = projectsStore.getById(projectId);
  if (!project) {
    res.status(404).json({ error: '项目不存在' });
    return;
  }

  const variables = variablesStore.filter(v => v.projectId === projectId);
  const simulations = simulationsStore.filter(s => s.projectId === projectId);
  const comparisons = comparisonsStore.filter(c => c.projectId === projectId);

  const exportData: ProjectExportData = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    project,
    variables,
    simulations,
    comparisons,
  };

  res.json(exportData);
});

router.get('/check-name/exists', (req: Request, res: Response) => {
  const name = (req.query.name as string)?.trim();
  if (!name) {
    res.status(400).json({ error: '项目名称不能为空' });
    return;
  }

  const existing = projectsStore.getAll().find(
    p => p.name.toLowerCase() === name.toLowerCase()
  );

  const result: CheckNameResult = {
    exists: !!existing,
  };

  if (existing) {
    let suffix = 1;
    let suggestedName = `${name} (导入)`;
    while (projectsStore.getAll().find(p => p.name.toLowerCase() === suggestedName.toLowerCase())) {
      suffix++;
      suggestedName = `${name} (导入 ${suffix})`;
    }
    result.suggestedName = suggestedName;
  }

  res.json(result);
});

function validateImportData(data: ProjectExportData): string | null {
  if (!data || !data.project) return '缺少项目数据';
  if (!data.project.name?.trim()) return '项目名称不能为空';

  const varIds = new Set<string>();
  for (const v of data.variables || []) {
    if (!v.id) return '存在无效的变量（缺少ID）';
    if (!v.name?.trim()) return '存在空名称的变量';
    if (varIds.has(v.id)) return `存在重复的变量ID: ${v.id}`;
    varIds.add(v.id);
    if (v.projectId !== data.project.id) {
      return `变量 ${v.name} 不属于该项目`;
    }
  }

  const simIds = new Set<string>();
  for (const s of data.simulations || []) {
    if (!s.id) return '存在无效的模拟结果（缺少ID）';
    if (simIds.has(s.id)) return `存在重复的模拟ID: ${s.id}`;
    simIds.add(s.id);
    if (s.projectId !== data.project.id) {
      return `模拟结果 ${s.runName || s.id} 不属于该项目`;
    }
    for (const item of s.sensitivity || []) {
      if (item.variableId && !varIds.has(item.variableId)) {
        return `模拟结果 ${s.runName || s.id} 的敏感性分析引用了不存在的变量`;
      }
    }
  }

  for (const c of data.comparisons || []) {
    if (!c.id) return '存在无效的对比记录（缺少ID）';
    if (c.projectId !== data.project.id) {
      return `对比记录 ${c.name || c.id} 不属于该项目`;
    }
    for (const simId of c.simulationIds || []) {
      if (!simIds.has(simId)) {
        return `对比记录 ${c.name || c.id} 引用了不存在的模拟结果`;
      }
    }
  }

  return null;
}

function rollbackImport(projectId: string, stages: {
  project: boolean;
  variables: boolean;
  simulations: boolean;
  comparisons: boolean;
}): void {
  try {
    if (stages.comparisons) {
      comparisonsStore.deleteMany(c => c.projectId === projectId);
    }
  } catch { /* ignore */ }
  try {
    if (stages.simulations) {
      simulationsStore.deleteMany(s => s.projectId === projectId);
    }
  } catch { /* ignore */ }
  try {
    if (stages.variables) {
      variablesStore.deleteMany(v => v.projectId === projectId);
    }
  } catch { /* ignore */ }
  try {
    if (stages.project) {
      projectsStore.delete(projectId);
    }
  } catch { /* ignore */ }
}

router.post('/import', (req: Request, res: Response) => {
  const dto = req.body as ImportProjectDto;
  if (!dto.data || !dto.data.project) {
    res.status(400).json({ error: '导入数据格式无效' });
    return;
  }

  const { data, newName } = dto;
  const projectName = (newName || data.project.name).trim();

  if (!projectName) {
    res.status(400).json({ error: '项目名称不能为空' });
    return;
  }

  const validationError = validateImportData(data);
  if (validationError) {
    res.status(400).json({ error: '数据验证失败: ' + validationError });
    return;
  }

  const existing = projectsStore.getAll().find(
    p => p.name.toLowerCase() === projectName.toLowerCase()
  );

  if (existing) {
    res.status(409).json({
      error: '项目名称已存在',
      exists: true,
      suggestedName: (() => {
        let suffix = 1;
        let suggested = `${projectName} (导入)`;
        while (projectsStore.getAll().find(p => p.name.toLowerCase() === suggested.toLowerCase())) {
          suffix++;
          suggested = `${projectName} (导入 ${suffix})`;
        }
        return suggested;
      })(),
    });
    return;
  }

  const newProjectId = uuidv4();
  const now = new Date().toISOString();

  const stages = {
    project: false,
    variables: false,
    simulations: false,
    comparisons: false,
  };

  try {
    const variableIdMap = new Map<string, string>();
    const newVariables: Variable[] = (data.variables || []).map(v => {
      const newId = uuidv4();
      variableIdMap.set(v.id, newId);
      return {
        ...v,
        id: newId,
        projectId: newProjectId,
        createdAt: now,
      };
    });

    const simulationIdMap = new Map<string, string>();
    const newSimulations: SimulationResult[] = (data.simulations || []).map(s => {
      const newId = uuidv4();
      simulationIdMap.set(s.id, newId);

      const newSensitivity = (s.sensitivity || [])
        .map(item => {
          const newVarId = variableIdMap.get(item.variableId);
          if (!newVarId) return null;
          const matchedVar = newVariables.find(v => v.id === newVarId);
          return {
            ...item,
            variableId: newVarId,
            variableName: matchedVar ? matchedVar.name : item.variableName,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);

      let newVariableSamples: Record<string, number[]> | undefined;
      if (s.variableSamples && Object.keys(s.variableSamples).length > 0) {
        newVariableSamples = {};
        for (const [oldVarId, samples] of Object.entries(s.variableSamples)) {
          const newVarId = variableIdMap.get(oldVarId);
          if (newVarId) {
            newVariableSamples[newVarId] = samples;
          }
        }
      }

      return {
        ...s,
        id: newId,
        projectId: newProjectId,
        timestamp: now,
        sensitivity: newSensitivity,
        variableSamples: newVariableSamples,
      };
    });

    const newComparisons: CompareRecord[] = (data.comparisons || [])
      .map(c => {
        const newSimulationIds = c.simulationIds
          .map(id => simulationIdMap.get(id))
          .filter((id): id is string => id !== undefined);
        return {
          ...c,
          id: uuidv4(),
          projectId: newProjectId,
          simulationIds: newSimulationIds,
          createdAt: now,
        };
      })
      .filter(c => c.simulationIds.length >= 2);

    const newProject: Project = {
      id: newProjectId,
      name: projectName,
      description: data.project.description || '',
      createdAt: now,
      updatedAt: now,
    };

    projectsStore.create(newProject);
    stages.project = true;

    variablesStore.bulkCreate(newVariables);
    stages.variables = true;

    simulationsStore.bulkCreate(newSimulations);
    stages.simulations = true;

    comparisonsStore.bulkCreate(newComparisons);
    stages.comparisons = true;

    const result: ImportResult = {
      success: true,
      project: newProject,
      variableCount: newVariables.length,
      simulationCount: newSimulations.length,
      comparisonCount: newComparisons.length,
    };

    res.status(201).json(result);
  } catch (err) {
    rollbackImport(newProjectId, stages);
    res.status(500).json({ error: '导入失败: ' + (err instanceof Error ? err.message : String(err)) });
  }
});

export default router;
