import {Body,Controller,Get,HttpException,Inject,Injectable,Module,NotFoundException,Param,Post} from '@nestjs/common';
import {WebSocketGateway,WebSocketServer} from '@nestjs/websockets';
import type {Server} from 'socket.io';
import {OllamaModelProvider} from '@local-agent/model-provider';
import {AgentDatabase} from './database';
import {manifests} from './skills';
import {Orchestrator} from './orchestrator';

@Injectable()
export class RuntimeService {
  readonly db=new AgentDatabase();
  readonly model=new OllamaModelProvider();
  readonly orchestrator=new Orchestrator(this.db,this.model);
}

@WebSocketGateway({namespace:'/agent',cors:{origin:'*'}})
export class AgentGateway {
  @WebSocketServer() server!:Server;
  constructor(@Inject(RuntimeService) runtime:RuntimeService){runtime.orchestrator.on('event',event=>{this.server?.emit('task.event',event);if(event.type==='TASK_COMPLETED')this.server?.emit('task.completed',event);else if(event.type==='TASK_FAILED')this.server?.emit('task.failed',event);else this.server?.emit('task.updated',event)})}
}

@Controller()
export class ApiController {
  constructor(@Inject(RuntimeService) private runtime:RuntimeService){}
  @Get('health') health(){return{status:'ok',service:'local-agent-api'}}
  @Get('models/health') async modelHealth(){return this.runtime.model.healthCheck()}
  @Get('skills') skills(){return manifests}
  @Get('skills/:id') skill(@Param('id')id:string){const skill=manifests.find(s=>s.id===id);if(!skill)throw new NotFoundException();return skill}
  @Post('tasks') create(@Body()body:{input?:string}){if(!body.input?.trim())throw new HttpException('input is required',400);const task=this.runtime.db.createTask(body.input.trim());void this.runtime.orchestrator.run(task.id,task.userInput);return task}
  @Get('tasks') tasks(){return this.runtime.db.listTasks()}
  @Get('tasks/:id') task(@Param('id')id:string){const task=this.runtime.db.getTask(id);if(!task)throw new NotFoundException();return task}
  @Post('tasks/:id/cancel') cancel(@Param('id')id:string){if(!this.runtime.db.getTask(id))throw new NotFoundException();this.runtime.orchestrator.cancel(id);return{accepted:true}}
  @Get('tasks/:id/events') events(@Param('id')id:string){return this.runtime.db.events(id)}
}

@Module({providers:[RuntimeService,AgentGateway],controllers:[ApiController],exports:[RuntimeService]}) export class TaskModule{}
@Module({}) export class OrchestratorModule{} @Module({}) export class PlannerModule{}
@Module({}) export class SkillRegistryModule{} @Module({}) export class SkillRouterModule{}
@Module({}) export class ExecutorModule{} @Module({}) export class ModelGatewayModule{}
@Module({}) export class AuditModule{} @Module({}) export class WebSocketModule{}
@Module({}) export class HealthModule{}
@Module({imports:[TaskModule,OrchestratorModule,PlannerModule,SkillRegistryModule,SkillRouterModule,ExecutorModule,ModelGatewayModule,AuditModule,WebSocketModule,HealthModule]})
export class AppModule{}
