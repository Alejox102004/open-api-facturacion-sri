import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Logger,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { EmisoresService } from './emisores.service';
import { CreateEmisorDto, UpdateEmisorDto, EmisorResponseDto } from './dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtPayload, UserRole } from '../auth/dto/auth.dto';

@ApiTags('Emisores')
@ApiBearerAuth('JWT')
@Controller('emisores')
export class EmisoresController {
  private readonly logger = new Logger(EmisoresController.name);

  constructor(private readonly emisoresService: EmisoresService) {}

  @Get()
  @ApiOperation({ summary: 'Listar emisores del tenant actual' })
  @ApiResponse({
    status: 200,
    description: 'Lista de emisores',
    type: [EmisorResponseDto],
  })
  async findAll(@CurrentUser() user: JwtPayload): Promise<EmisorResponseDto[]> {
    // SUPERADMIN ve todos, otros ven solo los de su tenant
    if (user.rol === UserRole.SUPERADMIN) {
      return this.emisoresService.findAll();
    }
    return this.emisoresService.findAllByTenant(user.tenantId!);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener un emisor por ID' })
  @ApiResponse({
    status: 200,
    description: 'Emisor encontrado',
    type: EmisorResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Emisor no encontrado' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<EmisorResponseDto> {
    return this.emisoresService.findOneSecured(id, user);
  }

  @Post()
  @ApiOperation({ summary: 'Crear un nuevo emisor' })
  @ApiResponse({
    status: 201,
    description: 'Emisor creado',
    type: EmisorResponseDto,
  })
  @ApiResponse({ status: 400, description: 'RUC ya existe' })
  async create(
    @Body() dto: CreateEmisorDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<EmisorResponseDto> {
    // Si no es SUPERADMIN, forzar el tenantId del usuario
    if (user.rol !== UserRole.SUPERADMIN && user.tenantId) {
      dto.tenantId = user.tenantId;
    }
    return this.emisoresService.create(dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualizar un emisor' })
  @ApiResponse({
    status: 200,
    description: 'Emisor actualizado',
    type: EmisorResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Emisor no encontrado' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateEmisorDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<EmisorResponseDto> {
    // Verificar acceso al emisor antes de actualizar
    await this.emisoresService.findOneSecured(id, user);
    return this.emisoresService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Inactivar un emisor (eliminación lógica)' })
  @ApiResponse({
    status: 200,
    description: 'Emisor inactivado',
    type: EmisorResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Emisor ya está inactivo' })
  @ApiResponse({ status: 404, description: 'Emisor no encontrado' })
  async delete(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<EmisorResponseDto> {
    await this.emisoresService.findOneSecured(id, user);
    return this.emisoresService.delete(id);
  }

  @Post('upload-logo')
  @ApiOperation({ summary: 'Subir logotipo comercial del emisor (JPEG/PNG)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        logo: { type: 'string', format: 'binary' },
        ruc: { type: 'string' },
      },
      required: ['logo', 'ruc'],
    },
  })
  @ApiResponse({ status: 201, description: 'Logotipo subido y guardado exitosamente' })
  @ApiResponse({ status: 400, description: 'Logotipo o RUC no proporcionado, o formato inválido' })
  @UseInterceptors(
    FileInterceptor('logo', {
      fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
        if (allowedTypes.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new BadRequestException('Solo se permiten imágenes JPEG o PNG') as any, false);
        }
      },
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
    }),
  )
  async uploadLogo(
    @UploadedFile() file: Express.Multer.File,
    @Body('ruc') ruc: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<EmisorResponseDto> {
    if (!file) {
      throw new BadRequestException('No se proporcionó ningún archivo de logotipo');
    }
    if (!ruc) {
      throw new BadRequestException('Se requiere el RUC del emisor');
    }

    // Validar acceso del usuario al emisor/RUC
    await this.emisoresService.validateRucAccess(ruc, user);

    return this.emisoresService.uploadLogo(ruc, file.buffer);
  }
}
