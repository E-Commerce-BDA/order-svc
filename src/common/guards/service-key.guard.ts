import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

export const DEFAULT_INTERNAL_SERVICE_KEY =
  'dev-internal-service-key-change-in-prod';

@Injectable()
export class ServiceKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const serviceKey = request.headers['x-service-key'];

    if (!serviceKey) {
      throw new UnauthorizedException('Missing x-service-key header');
    }

    const expectedKey =
      process.env.INTERNAL_SERVICE_KEY || DEFAULT_INTERNAL_SERVICE_KEY;

    if (serviceKey !== expectedKey) {
      throw new UnauthorizedException('Invalid service key');
    }

    return true;
  }
}
