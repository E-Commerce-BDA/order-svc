import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './../src/auth/auth.constants.js';
import { closePool, getPool } from './../src/db/pool.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}
process.env.DATABASE_URL ??= 'postgresql://ecom:ecom-dev-only@localhost:5433/ecom';

describe('Discounts (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let adminToken: string;
  let customerToken: string;

  beforeAll(async () => {
    // Ensure DB schema & seed exist
    const pool = getPool();
    const schemaSql = readFileSync(
      join(__dirname, '../db/001-order-schema.sql'),
      'utf-8',
    );
    await pool.query(schemaSql);
    const seedSql = readFileSync(
      join(__dirname, '../db/002-seed-orders.sql'),
      'utf-8',
    );
    await pool.query(seedSql);

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api/v1', {
      exclude: ['health', 'health/ready'],
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    jwtService = app.get(JwtService);
    const configService = app.get(ConfigService);
    const secret = configService.getOrThrow<string>('JWT_SECRET');

    adminToken = await jwtService.signAsync(
      {
        sub: '018f0000-0000-7000-8000-000000000001',
        email: 'admin@example.com',
        roles: ['admin'],
      },
      {
        secret,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: JWT_ALGORITHM,
        expiresIn: '1h',
      },
    );

    customerToken = await jwtService.signAsync(
      {
        sub: '018f0000-0000-7000-8000-000000000002',
        email: 'customer@example.com',
        roles: ['customer'],
      },
      {
        secret,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: JWT_ALGORITHM,
        expiresIn: '1h',
      },
    );
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  describe('POST /api/v1/discount-codes/validate', () => {
    it('validates percentage coupon SAVE10 successfully', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/discount-codes/validate')
        .send({ code: 'save10', cartTotal: 100 })
        .expect(200);

      expect(res.body.valid).toBe(true);
      expect(res.body.code).toBe('SAVE10');
      expect(res.body.discountType).toBe('percent');
      expect(res.body.discount).toBe(10);
    });

    it('validates fixed coupon FLAT20 with qualifying cart total', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/discount-codes/validate')
        .send({ code: 'FLAT20', cartTotal: 60 })
        .expect(200);

      expect(res.body.valid).toBe(true);
      expect(res.body.discountType).toBe('fixed');
      expect(res.body.discount).toBe(20);
    });

    it('rejects fixed coupon FLAT20 when cart total is below minimum amount of $50', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/discount-codes/validate')
        .send({ code: 'FLAT20', cartTotal: 40 })
        .expect(200);

      expect(res.body.valid).toBe(false);
      expect(res.body.message).toContain('minimum order amount');
    });

    it('rejects expired coupon EXPIRED50', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/discount-codes/validate')
        .send({ code: 'EXPIRED50', cartTotal: 100 })
        .expect(200);

      expect(res.body.valid).toBe(false);
      expect(res.body.message).toContain('expired');
    });

    it('rejects maxed-out coupon MAXEDOUT', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/discount-codes/validate')
        .send({ code: 'MAXEDOUT', cartTotal: 100 })
        .expect(200);

      expect(res.body.valid).toBe(false);
      expect(res.body.message).toContain('usage limit reached');
    });

    it('rejects disabled coupon DISABLED5', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/discount-codes/validate')
        .send({ code: 'DISABLED5', cartTotal: 100 })
        .expect(200);

      expect(res.body.valid).toBe(false);
      expect(res.body.message).toContain('inactive');
    });

    it('supports dual-mount route /api/v1/order/discount-codes/validate', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/order/discount-codes/validate')
        .send({ code: 'SAVE10', cartTotal: 50 })
        .expect(200);

      expect(res.body.valid).toBe(true);
      expect(res.body.discount).toBe(5);
    });
  });

  describe('Admin Coupon CRUD', () => {
    let createdCouponId: string;

    it('blocks unauthenticated access to admin endpoints with 401', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/discount-codes')
        .expect(401);
    });

    it('blocks non-admin access with 403 Forbidden', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/discount-codes')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);
    });

    it('allows admin to create a new coupon with 201', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/discount-codes')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: 'PROMO25',
          discountType: 'percent',
          value: 25,
          minOrderAmount: 20,
          maxUses: 50,
          isActive: true,
        })
        .expect(201);

      expect(res.body.code.code).toBe('PROMO25');
      expect(res.body.code.discount_type).toBe('percent');
      createdCouponId = res.body.code.id;
    });

    it('allows admin to list coupons with pagination', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/discount-codes?page=1&perPage=10')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
    });

    it('allows admin to get a coupon by id', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/discount-codes/${createdCouponId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.code.id).toBe(createdCouponId);
      expect(res.body.code.code).toBe('PROMO25');
    });

    it('allows admin to update coupon details', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/discount-codes/${createdCouponId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          value: 30,
          maxUses: 100,
        })
        .expect(200);

      expect(parseFloat(res.body.code.value)).toBe(30);
      expect(res.body.code.max_uses).toBe(100);
    });

    it('allows admin to delete a coupon with 204', async () => {
      await request(app.getHttpServer())
        .delete(`/api/v1/discount-codes/${createdCouponId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/v1/discount-codes/${createdCouponId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });
});
