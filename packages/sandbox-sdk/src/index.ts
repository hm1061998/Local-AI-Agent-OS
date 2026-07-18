export interface SkillWorkspace { read(path:string):Promise<string>;write(path:string,content:string):Promise<void>;list(path:string):Promise<string[]> }
export interface SkillLogger { info(message:string,data?:Record<string,unknown>):void;warn(message:string,data?:Record<string,unknown>):void;error(message:string,data?:Record<string,unknown>):void }
export interface SkillContext { taskId:string;executionId:string;workspace:SkillWorkspace;logger:SkillLogger;signal:AbortSignal }
export interface ExecutableSkill<TInput,TOutput>{run(input:TInput,context:SkillContext):Promise<TOutput>}
export interface JsonLineRequest<T=unknown>{taskId:string;executionId:string;input:T}
export interface JsonLineResponse<T=unknown>{executionId:string;ok:boolean;output?:T;error?:{code:string;message:string}}
