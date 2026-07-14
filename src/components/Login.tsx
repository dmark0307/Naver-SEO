import React, { useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { LogIn, Lock, User, Shield } from 'lucide-react';
import { motion } from 'motion/react';

export const Login: React.FC = () => {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { login } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // [Task] Apply trim() and String conversion for robust comparison
    const envAdminId = String(import.meta.env.VITE_ADMIN_ID || 'admin').trim().toLowerCase();
    const envAdminPw = String(import.meta.env.VITE_ADMIN_PASSWORD || '').trim();
    const inputId = String(id || '').trim().toLowerCase();

    // Check if env vars are missing for admin
    const isAdmin = inputId === envAdminId;
    if (isAdmin && !envAdminPw) {
      console.warn('관리자 비밀번호 환경변수가 설정되지 않았습니다. 기본 비밀번호(1234)를 사용합니다.');
    }

    const success = await login(id, password);
    if (!success) {
      setError('아이디 또는 비밀번호가 올바르지 않습니다.');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 border border-gray-100"
      >
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-black text-white rounded-2xl mb-4">
            <LogIn size={32} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">시스템 로그인</h1>
          <p className="text-gray-500 mt-2">서비스를 이용하려면 계정 정보를 입력하세요.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {(!String(import.meta.env.VITE_ADMIN_ID || '').trim() || !String(import.meta.env.VITE_ADMIN_PASSWORD || '').trim()) && (
            <div className="text-amber-600 text-[11px] bg-amber-50 p-2 rounded border border-amber-100 flex items-center gap-2">
              <Shield size={14} className="flex-shrink-0" />
              <span>보안 설정(환경변수)이 완료되지 않았습니다. 현재 기본 정보로 동작 중입니다.</span>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">아이디</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                <User size={18} />
              </span>
              <input 
                type="text"
                value={id}
                onChange={(e) => setId(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-black focus:border-transparent transition-all outline-none"
                placeholder="관리자 또는 유저 ID"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">비밀번호</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                <Lock size={18} />
              </span>
              <input 
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-black focus:border-transparent transition-all outline-none"
                placeholder="비밀번호를 입력하세요"
                required
              />
            </div>
          </div>

          {error && (
            <div className="text-red-500 text-sm bg-red-50 p-3 rounded-lg border border-red-100">
              {error}
            </div>
          )}

          <button 
            type="submit"
            className="w-full py-3 bg-black text-white rounded-xl font-bold hover:bg-gray-800 transition-colors shadow-lg shadow-black/10"
          >
            로그인하기
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-gray-100 text-center">
          <p className="text-xs text-gray-400">© 2026 AI Product SEO System. All rights reserved.</p>
        </div>
      </motion.div>
    </div>
  );
};
