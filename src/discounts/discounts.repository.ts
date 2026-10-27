import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import type { DiscountCodeRow } from '../db/rows.js';
import { CreateDiscountCodeDto } from './dto/create-discount-code.dto.js';
import { UpdateDiscountCodeDto } from './dto/update-discount-code.dto.js';

@Injectable()
export class DiscountsRepository {
  private get pool(): Pool {
    return getPool();
  }

  async findByCode(code: string): Promise<DiscountCodeRow | null> {
    const normalized = code.trim().toUpperCase();
    const { rows } = await this.pool.query<DiscountCodeRow>(
      `SELECT * FROM "order".discount_codes WHERE code = $1 LIMIT 1;`,
      [normalized],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<DiscountCodeRow | null> {
    const { rows } = await this.pool.query<DiscountCodeRow>(
      `SELECT * FROM "order".discount_codes WHERE id = $1 LIMIT 1;`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findAll(
    page = 1,
    perPage = 20,
  ): Promise<{ data: DiscountCodeRow[]; total: number; page: number; perPage: number }> {
    const offset = (page - 1) * perPage;

    const countRes = await this.pool.query<{ count: string }>(
      `SELECT count(*) FROM "order".discount_codes;`,
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const { rows } = await this.pool.query<DiscountCodeRow>(
      `SELECT * FROM "order".discount_codes 
       ORDER BY created_at DESC 
       LIMIT $1 OFFSET $2;`,
      [perPage, offset],
    );

    return {
      data: rows,
      total,
      page,
      perPage,
    };
  }

  async create(dto: CreateDiscountCodeDto): Promise<DiscountCodeRow> {
    const normalized = dto.code.trim().toUpperCase();
    const { rows } = await this.pool.query<DiscountCodeRow>(
      `INSERT INTO "order".discount_codes (
        code, discount_type, value, min_order_amount, max_uses, starts_at, ends_at, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;`,
      [
        normalized,
        dto.discountType,
        dto.value,
        dto.minOrderAmount ?? null,
        dto.maxUses ?? null,
        dto.startsAt ? new Date(dto.startsAt) : null,
        dto.endsAt ? new Date(dto.endsAt) : null,
        dto.isActive ?? true,
      ],
    );
    return rows[0];
  }

  async update(id: string, dto: UpdateDiscountCodeDto): Promise<DiscountCodeRow | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (dto.code !== undefined) {
      fields.push(`code = $${idx++}`);
      values.push(dto.code.trim().toUpperCase());
    }
    if (dto.discountType !== undefined) {
      fields.push(`discount_type = $${idx++}`);
      values.push(dto.discountType);
    }
    if (dto.value !== undefined) {
      fields.push(`value = $${idx++}`);
      values.push(dto.value);
    }
    if (dto.minOrderAmount !== undefined) {
      fields.push(`min_order_amount = $${idx++}`);
      values.push(dto.minOrderAmount);
    }
    if (dto.maxUses !== undefined) {
      fields.push(`max_uses = $${idx++}`);
      values.push(dto.maxUses);
    }
    if (dto.startsAt !== undefined) {
      fields.push(`starts_at = $${idx++}`);
      values.push(dto.startsAt ? new Date(dto.startsAt) : null);
    }
    if (dto.endsAt !== undefined) {
      fields.push(`ends_at = $${idx++}`);
      values.push(dto.endsAt ? new Date(dto.endsAt) : null);
    }
    if (dto.isActive !== undefined) {
      fields.push(`is_active = $${idx++}`);
      values.push(dto.isActive);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const query = `
      UPDATE "order".discount_codes
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING *;
    `;

    const { rows } = await this.pool.query<DiscountCodeRow>(query, values);
    return rows[0] ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM "order".discount_codes WHERE id = $1;`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async incrementUsesCount(client: PoolClient, id: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE "order".discount_codes 
       SET uses_count = uses_count + 1 
       WHERE id = $1 AND (max_uses IS NULL OR uses_count < max_uses);`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }
}
