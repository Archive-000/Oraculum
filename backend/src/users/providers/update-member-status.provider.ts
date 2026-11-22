import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { MembershipStatus } from '../enums/membership-status.enum';
import { UserRole } from '../enums/userRoles.enum';
import {
  AuditAction,
  AuditActor,
  AuditService,
} from '../../audit/audit.service';

@Injectable()
export class UpdateMemberStatusProvider {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Change a member's status and leave an audit trail (#858).
   *
   * The audit row records the status the member had before the change, the
   * new status and the administrator who made the change. When
   * `actingAdmin` is omitted the actor is left undefined so AuditService
   * resolves it from the current request user; passing `{}` would defeat
   * that fallback and record an anonymous actor.
   */
  async updateStatus(
    memberId: string,
    status: MembershipStatus,
    actingAdmin?: AuditActor,
  ): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id: memberId },
    });
    if (!user) {
      throw new NotFoundException(`Member with id "${memberId}" not found`);
    }

    if (
      user.role === UserRole.SUPER_ADMIN &&
      status !== MembershipStatus.ACTIVE
    ) {
      const superAdmins = await this.usersRepository.count({
        where: { role: UserRole.SUPER_ADMIN },
      });
      if (superAdmins <= 1) {
        throw new ForbiddenException('Cannot demote the last super-admin');
      }
    }

    const previousStatus = user.membershipStatus;

    user.membershipStatus = status;

    // Keep isSuspended in sync for backward compatibility
    user.isSuspended = status === MembershipStatus.SUSPENDED;
    user.isActive = status !== MembershipStatus.SUSPENDED;

    // Set memberSince when activating for the first time
    if (status === MembershipStatus.ACTIVE && !user.memberSince) {
      user.memberSince = new Date();
    }

    const saved = await this.usersRepository.save(user);

    await this.auditService.log({
      action: AuditAction.MEMBERSHIP_STATUS_CHANGED,
      actor: actingAdmin,
      resourceType: 'User',
      resourceId: memberId,
      metadata: { previousStatus, status },
    });

    return saved;
  }
}
